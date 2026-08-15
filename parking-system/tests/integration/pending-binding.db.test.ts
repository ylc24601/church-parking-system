import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 5A — LINE webhook → pending binding capture, end-to-end through the real route handler
// against local Supabase. Gated: `RUN_DB_TESTS=1` + reachable local DB (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'
const SECRET = 'test-line-channel-secret-5a'

type Sb = import('@supabase/supabase-js').SupabaseClient

// Isolated userId namespace so this test never collides with real captures or the seed.
const U = (s: string) => `Utest5a-${s}`
const sign = (raw: string) => createHmac('sha256', SECRET).update(raw, 'utf8').digest('base64')

function signedRequest(body: unknown, signature?: string): Request {
  const raw = JSON.stringify(body)
  return new Request('http://localhost/api/line/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': signature ?? sign(raw) },
    body: raw,
  })
}

describe.skipIf(!RUN)('LINE webhook → pending_binding — local DB integration', () => {
  let sb: Sb
  let POST: (req: Request) => Promise<Response>

  const activeRow = async (lineUserId: string) =>
    (await sb.from('pending_binding').select('*').eq('line_user_id', lineUserId).eq('status', 'pending').maybeSingle()).data

  const cleanup = async () => {
    for (const s of ['A', 'B', 'C']) {
      await sb.from('pending_binding').delete().eq('line_user_id', U(s))
    }
  }

  beforeAll(async () => {
    process.env.LINE_CHANNEL_SECRET = SECRET
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    POST = (await import('@/app/api/line/webhook/route')).POST
    await cleanup()
  })

  afterAll(async () => {
    if (!RUN) return
    await cleanup()
  })

  it('captures a valid bind message into a single pending row (normalized code)', async () => {
    const res = await POST(signedRequest({
      events: [{ type: 'message', message: { type: 'text', text: 'bind abc-123' }, source: { type: 'user', userId: U('A') } }],
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, captured: 1, superseded: 0 })

    const row = await activeRow(U('A'))
    expect(row).toMatchObject({ status: 'pending', submitted_code: 'ABC-123', superseded_count: 0, last_event_type: 'message' })
  })

  it('re-sending from the same user supersedes the active row in place (no flooding)', async () => {
    const res = await POST(signedRequest({
      events: [{ type: 'message', message: { type: 'text', text: '綁定 xyz789' }, source: { type: 'user', userId: U('A') } }],
    }))
    expect(await res.json()).toMatchObject({ captured: 1, superseded: 1 })

    // Exactly one active row, new code wins, supersede counter bumped.
    const rows = (await sb.from('pending_binding').select('*').eq('line_user_id', U('A')).eq('status', 'pending')).data
    expect(rows).toHaveLength(1)
    expect(rows![0]).toMatchObject({ submitted_code: 'XYZ789', superseded_count: 1 })
  })

  it('rejects an invalid x-line-signature and writes nothing', async () => {
    const res = await POST(signedRequest(
      { events: [{ type: 'message', message: { type: 'text', text: 'bind BAD123' }, source: { type: 'user', userId: U('B') } }] },
      'deadbeef-not-a-valid-signature',
    ))
    expect(res.status).toBe(401)
    expect(await activeRow(U('B'))).toBeNull()
  })

  it('ignores a non-binding message: 200 but no pending row', async () => {
    const res = await POST(signedRequest({
      events: [{ type: 'message', message: { type: 'text', text: '請問怎麼停車？' }, source: { type: 'user', userId: U('C') } }],
    }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, captured: 0, ignored: 1 })
    expect(await activeRow(U('C'))).toBeNull()
  })

  it('never writes users.line_id (capture is claim-only)', async () => {
    const { count } = await sb
      .from('users')
      .select('*', { count: 'exact', head: true })
      .like('line_id', 'Utest5a-%')
    expect(count).toBe(0)
  })
})
