import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  className?: string
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 text-center',
        compact ? 'min-h-48 py-8' : 'min-h-[280px] py-12',
        className,
      )}
    >
      {Icon ? (
        <span className="rounded-2xl bg-senda-subtle p-3.5 text-senda-muted">
          <Icon size={compact ? 24 : 28} strokeWidth={1.75} />
        </span>
      ) : null}
      <h3 className={cn('mb-0 font-bold tracking-tight text-senda-ink', Icon ? 'mt-4' : '', compact ? 'text-base' : 'text-lg')}>
        {title}
      </h3>
      {description ? (
        <p className="mb-0 mt-2 max-w-md text-sm leading-6 text-senda-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}
