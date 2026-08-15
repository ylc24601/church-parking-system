import { getAdminSession } from '@/server/http/adminAuth'
import { getAdminTodoSnapshot } from '@/server/services/adminTodoService'
import AdminSidebar from './AdminSidebar'
import { AdminTodoProvider } from './AdminTodoProvider'

// Admin shell (Slice 3.5 follow-up). When logged in, wrap every /admin/* route in a
// persistent sidebar so navigation matches the mockup — routes stay independent, not
// an SPA. IMPORTANT: this session check ONLY decides whether to render the shell; it
// is NOT an auth gate. Every page and API keeps its own getAdminSession()/redirect
// (and /admin renders the login form itself when logged out) — do not remove those.
//
// Wave 3 (#8/#9): fetch the todo snapshot ONCE here and provide it to the whole
// subtree so the sidebar badges and the /admin overview read one consistent set of
// counts. getAdminTodoSnapshot is fail-soft (returns counts:null, never throws), so
// a count-query outage cannot 500 the entire back-office.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getAdminSession()
  if (!session) return <>{children}</> // login page renders bare, no sidebar

  const snapshot = await getAdminTodoSnapshot(session.role)

  return (
    <AdminTodoProvider snapshot={snapshot}>
      <div className="flex min-h-dvh flex-col bg-page lg:flex-row">
        <AdminSidebar username={session.username} role={session.role} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </AdminTodoProvider>
  )
}
