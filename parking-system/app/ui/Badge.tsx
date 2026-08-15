import type { ReactNode } from 'react'

// Shared status pill (Phase 9 Slice 3.5). Tone maps to the semantic status tokens
// in globals.css. A badge is ALWAYS colour + text/icon — never colour alone — so
// it stays legible for colour-blind users and in a dim garage. See design-spec.md §1.4.
export type BadgeTone = 'success' | 'warning' | 'info' | 'priority' | 'neutral' | 'danger'

const SOLID: Record<BadgeTone, string> = {
  success: 'bg-success-bg text-success-fg',
  warning: 'bg-warning-bg text-warning-fg',
  info: 'bg-info-bg text-info-fg',
  priority: 'bg-priority-bg text-priority-fg',
  neutral: 'bg-neutral-bg text-neutral-fg',
  danger: 'bg-danger-bg text-danger-fg',
}

// Outline variant kept minimal for now — Slice C (Admin) will refine padding/border
// against real tables. Don't over-build it here.
const OUTLINE: Record<BadgeTone, string> = {
  success: 'border border-success-fg/40 text-success-fg',
  warning: 'border border-warning-fg/40 text-warning-fg',
  info: 'border border-info-fg/40 text-info-fg',
  priority: 'border border-priority-fg/40 text-priority-fg',
  neutral: 'border border-neutral-fg/40 text-neutral-fg',
  danger: 'border border-danger-fg/40 text-danger-fg',
}

export default function Badge({
  tone,
  variant = 'solid',
  className = '',
  children,
}: {
  tone: BadgeTone
  variant?: 'solid' | 'outline'
  className?: string
  children: ReactNode
}) {
  const colors = variant === 'outline' ? OUTLINE[tone] : SOLID[tone]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold leading-tight ${colors} ${className}`}
    >
      {children}
    </span>
  )
}
