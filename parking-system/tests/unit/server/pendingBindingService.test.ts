import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import { parseBindCode, processWebhookEvents } from '@/server/services/pendingBindingService'

const NOW = '2026-06-21T02:30:00Z'

describe('parseBindCode', () => {
  it('accepts 綁定 / bind / BIND with a valid code, normalized to uppercase', () => {
    expect(parseBindCode('綁定 abc123')).toBe('ABC123')
    expect(parseBindCode('bind abc-123')).toBe('ABC-123')
    expect(parseBindCode('BIND ABC123')).toBe('ABC123')
    expect(parseBindCode('  bind   xy12  ')).toBe('XY12') // trimmed, collapsed whitespace after keyword
  })

  it('rejects non-binding text, wrong keyword, and arbitrary chat', () => {
    expect(parseBindCode('hello')).toBeNull()
    expect(parseBindCode('binding ABC123')).toBeNull()   // no separator after keyword
    expect(parseBindCode('綁定')).toBeNull()              // keyword only, no code
    expect(parseBindCode('請問怎麼停車')).toBeNull()
  })

  it('rejects codes outside ^[A-Z0-9-]{4,16}$', () => {
    expect(parseBindCode('bind abc')).toBeNull()          // too short (3)
    expect(parseBindCode('bind ' + 'A'.repeat(17))).toBeNull() // too long (17)
    expect(parseBindCode('bind ABC 123')).toBeNull()      // embedded space
    expect(parseBindCode('bind abc_123')).toBeNull()      // underscore not allowed
    expect(parseBindCode('bind 台北123')).toBeNull()       // non-ASCII not allowed
  })
})

function run(body: unknown, repoOver: Partial<MockRepo> = {}) {
  const repo = makeMockRepo(repoOver)
  return { repo, promise: processWebhookEvents(body, NOW, asRepo(repo)) }
}

describe('processWebhookEvents', () => {
  it('captures a valid bind message and passes the userId + normalized code to the repo', async () => {
    const { repo, promise } = run({
      events: [{ type: 'message', message: { type: 'text', text: 'bind abc-123' }, source: { type: 'user', userId: 'Uabc' } }],
    })
    expect(await promise).toEqual({ captured: 1, superseded: 0, ignored: 0, follows: 0, unsupported: 0 })
    expect(repo.capturePendingBinding).toHaveBeenCalledWith({
      lineUserId: 'Uabc', code: 'ABC-123', eventType: 'message', nowIso: NOW,
    })
  })

  it('counts a supersede reported by the repo', async () => {
    const { promise } = run(
      { events: [{ type: 'message', message: { type: 'text', text: '綁定 ABC123' }, source: { type: 'user', userId: 'Uabc' } }] },
      { capturePendingBinding: vi.fn(async () => ({ captured: 1, superseded: true })) },
    )
    expect(await promise).toMatchObject({ captured: 1, superseded: 1 })
  })

  it('counts follow events but never creates a claim from them', async () => {
    const { repo, promise } = run({ events: [{ type: 'follow', source: { type: 'user', userId: 'Uabc' } }] })
    expect(await promise).toMatchObject({ captured: 0, follows: 1 })
    expect(repo.capturePendingBinding).not.toHaveBeenCalled()
  })

  it('ignores non-binding text messages without writing', async () => {
    const { repo, promise } = run({
      events: [{ type: 'message', message: { type: 'text', text: '你好' }, source: { type: 'user', userId: 'Uabc' } }],
    })
    expect(await promise).toMatchObject({ captured: 0, ignored: 1 })
    expect(repo.capturePendingBinding).not.toHaveBeenCalled()
  })

  it('ignores a valid command that lacks a resolvable user source', async () => {
    const { repo, promise } = run({
      events: [{ type: 'message', message: { type: 'text', text: 'bind ABC123' }, source: { type: 'group', groupId: 'G1' } }],
    })
    expect(await promise).toMatchObject({ captured: 0, ignored: 1 })
    expect(repo.capturePendingBinding).not.toHaveBeenCalled()
  })

  it('classes non-text messages (sticker/image) and other event types as unsupported', async () => {
    const { repo, promise } = run({
      events: [
        { type: 'message', message: { type: 'sticker' }, source: { type: 'user', userId: 'Uabc' } },
        { type: 'unfollow', source: { type: 'user', userId: 'Uabc' } },
      ],
    })
    expect(await promise).toMatchObject({ captured: 0, ignored: 0, follows: 0, unsupported: 2 })
    expect(repo.capturePendingBinding).not.toHaveBeenCalled()
  })

  it('tolerates a malformed payload (no events array) as an empty summary', async () => {
    expect(await run(null).promise).toEqual({ captured: 0, superseded: 0, ignored: 0, follows: 0, unsupported: 0 })
    expect(await run({}).promise).toEqual({ captured: 0, superseded: 0, ignored: 0, follows: 0, unsupported: 0 })
  })
})
