import Link from 'next/link'
import Badge from '../../ui/Badge'
import { ROLE_LABEL, type MemberSearchItem } from '@/lib/memberAdminTypes'

// Wave 1c (#5A) — the member list, shared by search results and the roster browse. Both show the
// exact same five columns; two copies would drift (see lib/staffRow for the same lesson).
//
// It takes MemberSearchItem — the service's masked DTO — and nothing else. That type boundary is
// the guarantee: this component cannot render a full phone number or a raw line_id, because it is
// never given one (the service masks the phone and reduces line_id to `bound`).
//
// Presentational only: no hooks, so it renders in both a server component (roster) and a client
// one (search). Empty/loading/error states belong to the caller — this renders rows.

export default function MemberTable({ items }: { items: MemberSearchItem[] }) {
  return (
    <div className="w-full overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-surface text-muted">
          <tr>
            <th className="px-4 py-3 font-normal">姓名</th>
            <th className="whitespace-nowrap px-4 py-3 font-normal">電話</th>
            <th className="whitespace-nowrap px-4 py-3 font-normal">車牌</th>
            <th className="whitespace-nowrap px-4 py-3 font-normal">角色</th>
            <th className="whitespace-nowrap px-4 py-3 font-normal">綁定</th>
            <th className="px-4 py-3 font-normal"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map(m => (
            <tr key={m.id} className="bg-surface">
              <td className="px-4 py-3 text-ink">{m.displayName}</td>
              <td className="whitespace-nowrap px-4 py-3 font-mono text-muted">{m.phoneMasked}</td>
              <td className="whitespace-nowrap px-4 py-3 font-mono text-ink">{m.plateSummary || '—'}</td>
              <td className="whitespace-nowrap px-4 py-3 text-muted">{ROLE_LABEL[m.role] ?? m.role}</td>
              <td className="whitespace-nowrap px-4 py-3">
                {m.bound ? (
                  <Badge variant="outline" tone="success">已綁定</Badge>
                ) : (
                  <Badge variant="outline" tone="neutral">未綁定</Badge>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-3">
                <Link
                  href={`/admin/members/${m.id}`}
                  className="inline-flex min-h-11 items-center rounded-lg bg-primary px-3 text-sm font-medium text-white transition-colors hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  明細
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
