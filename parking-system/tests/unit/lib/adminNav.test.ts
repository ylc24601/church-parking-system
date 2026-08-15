import { describe, expect, it } from 'vitest'
import { ADMIN_NAV, buildAdminNav } from '@/lib/adminNav'

describe('buildAdminNav (#18 sidebar zones)', () => {
  it('superadmin → 8 daily items (in order, none gated) + 3 system items (in order)', () => {
    const { daily, system } = buildAdminNav('superadmin')
    expect(daily.map(i => i.href)).toEqual([
      '/admin/bindings',
      '/admin/members',
      '/admin/eligibility',
      '/admin/import',
      '/admin/print',
      '/admin/capacity',
      '/admin/pastoral',
      '/admin/staff-pin',
    ])
    expect(daily.every(i => i.capability === undefined)).toBe(true)
    expect(system.map(i => i.href)).toEqual(['/admin/accounts', '/admin/audit', '/admin/ops'])
  })

  it('clerk → only the 8 daily items; system zone empty ⇒ component renders no divider/system group', () => {
    const { daily, system } = buildAdminNav('clerk')
    expect(daily).toHaveLength(8)
    expect(system).toEqual([])
    // no capability-gated item leaked into a clerk's daily list
    expect(daily.every(i => i.capability === undefined)).toBe(true)
  })

  it('hrefs are unique — href is the React key, active-match, badge map, and nav identity', () => {
    const hrefs = ADMIN_NAV.map(i => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
  })

  it('current product policy: system-maintenance items are all capability-gated', () => {
    // NOT a type guarantee — today the 系統維運 zone happens to equal the #19 role boundary.
    // If an all-admin system page is ever added, update THIS test; it is not an architecture break.
    for (const item of ADMIN_NAV.filter(i => i.zone === 'system')) {
      expect(item.capability).toBeDefined()
    }
  })
})
