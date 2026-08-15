'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { AdminTodoSnapshot } from '@/lib/adminTodoTypes'

// Single source for the todo snapshot (Wave 3 / #8 + #9). The layout fetches ONE
// snapshot and provides it here; both the sidebar (in the layout) and the overview's
// 下待辦 (in the page subtree) read it via useAdminTodos(). This matters because a
// shared layout is NOT re-rendered on client-side sibling navigation (Next.js
// "Keeping any shared layouts and UI") — if the page fetched its own counts while
// the sidebar kept the layout's, the two would disagree. One provider ⇒ they can't.
//
// Freshness is deliberately a snapshot: it updates on full load and on router.refresh()
// (which mutations already call), not on every soft navigation.
const AdminTodoContext = createContext<AdminTodoSnapshot | null>(null)

export function AdminTodoProvider({
  snapshot,
  children,
}: {
  snapshot: AdminTodoSnapshot
  children: ReactNode
}) {
  return <AdminTodoContext.Provider value={snapshot}>{children}</AdminTodoContext.Provider>
}

export function useAdminTodos(): AdminTodoSnapshot {
  const ctx = useContext(AdminTodoContext)
  if (ctx === null) {
    throw new Error('useAdminTodos must be used within an AdminTodoProvider')
  }
  return ctx
}
