'use client'

// Tiny client island: the only interactive part of the print page. Never
// auto-prints on load — the operator chooses when to open the print dialog.
// Hidden from the printed output itself via the `print:hidden` utility.
export default function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 print:hidden"
    >
      🖨 列印
    </button>
  )
}
