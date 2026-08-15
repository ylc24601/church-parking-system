#!/usr/bin/env tsx
/**
 * 用法：
 *   npm run sync                # 自動判斷方向
 *   npm run sync:force-local    # 強制以本地覆蓋 Notion
 *   npm run sync:force-notion   # 強制以 Notion 覆蓋本地
 *
 * 環境變數（建議存在 .env 或直接 export）：
 *   NOTION_API_KEY=secret_xxxx
 */

import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import { markdownToBlocks } from '@tryfabric/martian';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const LOCAL_FILE = path.resolve(process.cwd(), 'notion-parking-proposal.md');
const args = process.argv.slice(2);
const forceLocal = args.includes('--force-local');
const forceNotion = args.includes('--force-notion');

// ─── 主流程 ──────────────────────────────────────────────

async function main() {
  if (!NOTION_API_KEY) {
    die(
      '請先設定環境變數：\n  export NOTION_API_KEY=secret_xxxx\n\n' +
      '取得金鑰步驟：\n' +
      '  1. 前往 https://developers.notion.com → Connections\n' +
      '  2. 點擊已建立的 connection（如 sync-notion）→ 複製 Access token\n' +
      '  3. 回到 Notion 頁面 → 右上角「···」→「Connect to」→ 選你的 connection\n' +
      '  4. export NOTION_API_KEY=<貼上 Access token>'
    );
  }

  const notion = new Client({ auth: NOTION_API_KEY });
  const n2m = new NotionToMarkdown({ notionClient: notion });

  // 讀本地檔案
  const raw = fs.readFileSync(LOCAL_FILE, 'utf-8');
  const { data: fm, content: localBody } = matter(raw);
  const pageId: string = fm.notion_id;
  if (!pageId) die('notion-parking-proposal.md 的 frontmatter 缺少 notion_id');

  const lastSynced  = fm.last_synced ? new Date(fm.last_synced) : new Date(0);
  const localMtime  = fs.statSync(LOCAL_FILE).mtime;

  // 取 Notion 頁面資訊
  const page = (await notion.pages.retrieve({ page_id: pageId })) as any;
  const notionEdited = new Date(page.last_edited_time);

  const localNewer  = localMtime  > lastSynced;
  const notionNewer = notionEdited > lastSynced;

  console.log(`上次同步  ${fmt(lastSynced)}`);
  console.log(`本地檔案  ${fmt(localMtime)}  ${localNewer  ? '✏️  有新改動' : '✅ 未改動'}`);
  console.log(`Notion    ${fmt(notionEdited)}  ${notionNewer ? '✏️  有新改動' : '✅ 未改動'}`);
  console.log('');

  // 判斷方向
  if (!forceLocal && !forceNotion) {
    if (localNewer && notionNewer) {
      die(
        '⚠️  衝突：兩端都有新改動，請手動決定要保留哪一版本：\n' +
        '  npm run sync:force-local   → 以本地覆蓋 Notion\n' +
        '  npm run sync:force-notion  → 以 Notion 覆蓋本地'
      );
    }
    if (!localNewer && !notionNewer) {
      console.log('✅ 兩端已是最新，無需同步。');
      return;
    }
  }

  const doPush = forceLocal || (!forceNotion && localNewer);
  if (doPush) {
    await pushToNotion(notion, pageId, localBody, fm);
  } else {
    await pullFromNotion(n2m, pageId, fm);
  }
}

// ─── 推送本地 → Notion ───────────────────────────────────

async function pushToNotion(notion: Client, pageId: string, body: string, fm: any) {
  console.log('⬆️  推送本地 → Notion ...');

  const blocks = markdownToBlocks(body.trim()) as any[];

  // 刪除現有 blocks（分頁處理，略過子頁面與資料庫）
  const toDelete: string[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await notion.blocks.children.list({
      block_id: pageId,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const b of res.results) {
      if (b.type === 'child_page' || b.type === 'child_database') {
        console.warn(`  略過子頁面/資料庫：${b.id}`);
        continue;
      }
      toDelete.push(b.id);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  for (const id of toDelete) {
    await notion.blocks.delete({ block_id: id });
  }

  // 寫入新 blocks（Notion API 每次最多 100 個）
  for (let i = 0; i < blocks.length; i += 100) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: blocks.slice(i, i + 100),
    });
  }

  writeSynced(fm, localBody);
  console.log('✅ 推送完成。');
}

// ─── 拉取 Notion → 本地 ──────────────────────────────────

async function pullFromNotion(n2m: NotionToMarkdown, pageId: string, fm: any) {
  console.log('⬇️  拉取 Notion → 本地 ...');

  const mdBlocks = await n2m.pageToMarkdown(pageId);
  const { parent: notionBody } = n2m.toMarkdownString(mdBlocks);

  writeSynced(fm, '\n' + notionBody.trim() + '\n');
  console.log('✅ 拉取完成。');
}

// ─── 工具函式 ─────────────────────────────────────────────

function writeSynced(fm: any, body: string) {
  const now = new Date();
  const nowIso = now.toISOString();
  const updated = matter.stringify(body, { ...fm, last_synced: nowIso });
  fs.writeFileSync(LOCAL_FILE, updated, 'utf-8');
  // 同步 mtime，避免下次誤判為「有新改動」
  fs.utimesSync(LOCAL_FILE, now, now);
  console.log(`last_synced → ${nowIso}`);
}

function fmt(d: Date) {
  if (d.getTime() === 0) return '（從未同步）';
  return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((err) => {
  console.error('❌', err.message ?? err);
  process.exit(1);
});
