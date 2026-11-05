import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Card({
  children,
  className,
  padded = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode
  padded?: boolean
}) {
  return (
    <section
      className={cn(
        'rounded-card border border-senda-border bg-senda-surface shadow-panel',
        padded && 'p-5',
        className,
      )}
      {...props}
    >
      {children}
    </section>
  )
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3 border-b border-senda-border px-5 py-4', className)}>
      <div className="min-w-0">
        <h3 className="gg-section-title">{title}</h3>
        {description ? <p className="gg-section-meta">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
