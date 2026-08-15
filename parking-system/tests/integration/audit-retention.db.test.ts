import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'

// Wave 2A-3 (#15) — audit_logs retention purge. Proves the bounded, self-auditing
// DELETE and, above all, the escape-hatch double lock that lets ONLY the purge remove
// append-only rows.
//
// ⚠️ ISOLATION IS MANDATORY: purge_audit_logs deletes globally by created_at, so a run
// that committed would wipe OTHER suites' append-only rows on this shared DB (worse
// than a mere INSERT collision — a real delete). Every test runs inside a raw-pg
// BEGIN…ROLLBACK, seeds its own rows (INSERT is allowed for the owner; the trigger only
// blocks update/delete/truncate), and rolls back — zero residue, and any row the purge
// deletes comes back on rollback.
//
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'
const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

describe.skipIf(!RUN)('audit_logs retention purge (Wave 2A-3 / #15)', () => {
  let pg: Client

  beforeAll(async () => {
    pg = new Client({ connectionString: DB_URL })
    await pg.connect()
  })
  afterAll(async () => { await pg?.end() })

  // Everything happens in one transaction that is always rolled back.
  const inTx = async (fn: () => Promise<void>) => {
    await pg.query('begin')
    try { await fn() } finally { await pg.query('rollback') }
  }

  // Seed one audit row aged `interval` in the past, as the owner (postgres).
  const seed = (interval: string, action = 'probe.old') =>
    pg.query(
      `insert into audit_logs (created_at, actor_type, action, entity_type, request_id, result, metadata_redacted)
       values (now() - $1::interval, 'system', $2, 'probe', gen_random_uuid(), 'success', '{}') returning id`,
      [interval, action],
    ).then(r => r.rows[0].id as string)

  const purge = (months: number, max: number, dryRun: boolean, reqId: string) =>
    pg.query(`select purge_audit_logs($1,$2,$3,$4) as r`, [months, max, dryRun, reqId])
      .then(r => r.rows[0].r as { count: number; has_more: boolean; deleted_before: string; retention_months: number })

  const exists = (id: string) =>
    pg.query(`select 1 from audit_logs where id=$1`, [id]).then(r => r.rowCount === 1)

  it('dry-run counts without deleting; a within-window row is never a candidate', async () => {
    await inTx(async () => {
      const old = [await seed('300 months'), await seed('290 months'), await seed('280 months')]
      const fresh = await seed('23 months', 'probe.new')
      const res = await purge(24, 500, true, randomUUID())
      expect(res.count).toBeGreaterThanOrEqual(3) // at least my three; nothing else is ~24mo old on a fresh reset
      expect(res.has_more).toBe(false)
      expect(typeof res.deleted_before).toBe('string')
      // Nothing deleted.
      for (const id of [...old, fresh]) expect(await exists(id)).toBe(true)
    })
  })

  it('apply deletes oldest-first, bounded by max, and reports has_more honestly', async () => {
    await inTx(async () => {
      // Aged far past anything a fresh DB holds, so these are the global oldest.
      const o1 = await seed('300 months')
      const o2 = await seed('290 months')
      const o3 = await seed('280 months')
      const fresh = await seed('23 months', 'probe.new')

      const b1 = await purge(24, 1, false, randomUUID())
      expect(b1.count).toBe(1)
      expect(b1.has_more).toBe(true)
      expect(await exists(o1)).toBe(false) // oldest went first
      expect(await exists(o2)).toBe(true)

      const b2 = await purge(24, 1, false, randomUUID())
      expect(b2.count).toBe(1)
      expect(await exists(o2)).toBe(false)

      await purge(24, 500, false, randomUUID())
      expect(await exists(o3)).toBe(false)
      // The within-window row survived every batch — the boundary is exactly right.
      expect(await exists(fresh)).toBe(true)
    })
  })

  it('the retention-exempt markers are never deleted, even when ancient', async () => {
    await inTx(async () => {
      const substrate = await seed('300 months', 'audit.substrate_enabled')
      const priorPurge = await seed('300 months', 'audit.retention_purge')
      const ordinary = await seed('300 months', 'probe.old')
      await purge(24, 500, false, randomUUID())
      expect(await exists(ordinary)).toBe(false)
      expect(await exists(substrate)).toBe(true)
      expect(await exists(priorPurge)).toBe(true)
    })
  })

  it('records ONE self-audit marker per delivering batch — count only, no ids or row data', async () => {
    await inTx(async () => {
      await seed('300 months')
      const reqId = randomUUID()
      const res = await purge(24, 500, false, reqId)
      expect(res.count).toBeGreaterThanOrEqual(1)
      const markers = (await pg.query(
        `select action, result, metadata_redacted from audit_logs where request_id=$1`, [reqId],
      )).rows as Array<{ action: string; result: string; metadata_redacted: Record<string, unknown> }>
      expect(markers).toHaveLength(1)
      expect(markers[0].action).toBe('audit.retention_purge')
      expect(markers[0].result).toBe('success')
      // Exactly the three flat keys; nothing that could identify a deleted row.
      expect(Object.keys(markers[0].metadata_redacted).sort())
        .toEqual(['deleted_before', 'deleted_count', 'retention_months'])
      expect(markers[0].metadata_redacted.deleted_count).toBe(res.count)
    })
  })

  it('a zero-delete run writes NO marker (keeps the exempt set tiny — 0030:369 rule)', async () => {
    await inTx(async () => {
      const reqId = randomUUID()
      // A 100-year window matches nothing, so it deletes 0 and must record nothing.
      const res = await purge(1200, 500, false, reqId)
      expect(res.count).toBe(0)
      const markers = await pg.query(`select 1 from audit_logs where request_id=$1`, [reqId])
      expect(markers.rowCount).toBe(0)
    })
  })

  // ── The escape hatch: only the purge can delete; the seam does not leak ──────────
  it('the purge deletes when called by service_role (the granted path works)', async () => {
    await inTx(async () => {
      const old = await seed('300 months')          // as owner
      await pg.query(`set local role service_role`) // now the app principal
      const res = await purge(24, 500, false, randomUUID())
      expect(res.count).toBeGreaterThanOrEqual(1)
      expect(await exists(old)).toBe(false)
    })
  })

  it('service_role CANNOT delete directly — even with the GUC set on (lock 2: owner identity)', async () => {
    await inTx(async () => {
      const id = await seed('300 months')
      await pg.query(`set local role service_role`)
      // GUC on but current_user = service_role ≠ owner → still blocked. Grant layer
      // also blocks (delete revoked), which is exactly the point: the seam needs BOTH.
      await pg.query(`select set_config('audit.allow_purge','on',true)`)
      await expect(pg.query(`delete from audit_logs where id=$1`, [id]))
        .rejects.toThrow(/append-only|permission denied/)
    })
  })

  it('the GUC is reset to off after the purge — a later DELETE in the same txn is re-blocked', async () => {
    await inTx(async () => {
      await seed('300 months')
      const victim = await seed('23 months', 'probe.new') // within window; purge won't touch it
      await purge(24, 500, false, randomUUID())           // opens then CLOSES the seam
      // As owner, GUC now off → the trigger blocks even the owner. Proves the fn closed
      // the seam itself rather than leaning on transaction end.
      await expect(pg.query(`delete from audit_logs where id=$1`, [victim]))
        .rejects.toThrow(/append-only/)
    })
  })

  it('UPDATE stays absolutely blocked even with the seam open (only DELETE has a seam)', async () => {
    await inTx(async () => {
      const id = await seed('300 months')
      await pg.query(`select set_config('audit.allow_purge','on',true)`) // even with the seam open
      await expect(pg.query(`update audit_logs set action='x.y' where id=$1`, [id]))
        .rejects.toThrow(/append-only/)
    })
  })

  it('TRUNCATE stays absolutely blocked even with the seam open', async () => {
    // Inside a rolled-back txn on purpose: TRUNCATE is transactional, so if this ever
    // slipped past the trigger the rollback still saves the shared DB.
    await inTx(async () => {
      await pg.query(`select set_config('audit.allow_purge','on',true)`)
      await expect(pg.query(`truncate audit_logs`)).rejects.toThrow(/append-only/)
    })
  })

  it('rejects a window shorter than policy, a bad max, or a missing request id', async () => {
    await expect(purge(23, 500, true, randomUUID())).rejects.toThrow(/retention_months/)
    await expect(pg.query(`select purge_audit_logs(null,500,true,gen_random_uuid())`)).rejects.toThrow(/retention_months/)
    await expect(pg.query(`select purge_audit_logs(24,0,true,gen_random_uuid())`)).rejects.toThrow(/p_max/)
    await expect(pg.query(`select purge_audit_logs(24,501,true,gen_random_uuid())`)).rejects.toThrow(/p_max/)
    await expect(pg.query(`select purge_audit_logs(24,500,true,null)`)).rejects.toThrow(/request_id/)
  })
})
