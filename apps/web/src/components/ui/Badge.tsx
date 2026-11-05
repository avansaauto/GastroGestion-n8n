import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type BadgeTone = 'neutral' | 'warning' | 'success' | 'danger' | 'info' | 'brand'

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: BadgeTone
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide',
        tone === 'neutral' && 'bg-senda-subtle text-senda-muted ring-1 ring-inset ring-senda-border',
        tone === 'warning' && 'bg-orange-50 text-orange-900 ring-1 ring-inset ring-orange-200',
        tone === 'success' && 'bg-emerald-50 text-emerald-900 ring-1 ring-inset ring-emerald-200',
        tone === 'danger' && 'bg-red-50 text-red-800 ring-1 ring-inset ring-red-200',
        tone === 'info' && 'bg-sky-50 text-sky-900 ring-1 ring-inset ring-sky-200',
        tone === 'brand' && 'bg-orange-50 text-senda-orange ring-1 ring-inset ring-orange-200',
        className,
      )}
    >
      {children}
    </span>
  )
}
