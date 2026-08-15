import { describe, expect, it } from 'vitest'
import { ADMIN_ROLE_LABEL, can, type AdminCapability, type AdminRole } from '@/lib/adminRoles'

// Wave 2C-1 (#19). The matrix is the single answer to "may this operator open that",
// shared by the server gates and the sidebar, so the table below is written out in full
// rather than derived — a test that computed the expectation the same way the code does
// would agree with any bug.
//
// The capabilities exist because those surfaces are NOT open to every admin. Everything else
// (bindings, members browse, eligibility, import, print, capacity, pastoral, staff PIN) is
// deliberately absent from the matrix: a capability for "what everyone can do" would make the
// lack of a check elsewhere look like an oversight. export_members (#5B-a) is superadmin-only
// bulk-PII egress and joins the restricted set.

const EXPECTED: Record<AdminRole, Record<AdminCapability, boolean>> = {
  superadmin: { manage_admin_accounts: true, view_ops: true, view_audit: true, export_members: true },
  clerk: { manage_admin_accounts: false, view_ops: false, view_audit: false, export_members: false },
}

describe('admin capability matrix', () => {
  it.each(
    (Object.keys(EXPECTED) as AdminRole[]).flatMap(role =>
      (Object.keys(EXPECTED[role]) as AdminCapability[]).map(
        cap => [role, cap, EXPECTED[role][cap]] as const,
      ),
    ),
  )('%s / %s → %s', (role, capability, expected) => {
    expect(can(role, capability)).toBe(expected)
  })

  it('每個角色都有中文名稱可顯示', () => {
    // The UI must never fall back to printing the raw enum value at a 同工.
    for (const role of Object.keys(EXPECTED) as AdminRole[]) {
      expect(ADMIN_ROLE_LABEL[role]).toBeTruthy()
      expect(ADMIN_ROLE_LABEL[role]).not.toBe(role)
    }
  })

  it('幹事 holds none of the restricted capabilities', () => {
    // Stated separately from the table because this is the whole point of the slice:
    // if a future edit flips one of these to true it should fail here by name, not as
    // one anonymous row in a parameterised list.
    const caps = Object.keys(EXPECTED.clerk) as AdminCapability[]
    expect(caps.filter(c => can('clerk', c))).toEqual([])
    expect(caps.filter(c => can('superadmin', c))).toEqual(caps)
  })
})
