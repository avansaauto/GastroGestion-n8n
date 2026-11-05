import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  meta,
  actions,
  className,
}: {
  title: string
  description?: string
  meta?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4 border-b border-senda-border pb-5', className)}>
      <div className="min-w-0 max-w-3xl">
        <h2 className="m-0 text-display text-senda-ink">{title}</h2>
        {description ? (
          <p className="mb-0 mt-2 max-w-2xl text-sm leading-6 text-senda-muted">{description}</p>
        ) : null}
        {meta ? <div className="mt-2 text-xs text-senda-muted">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}
