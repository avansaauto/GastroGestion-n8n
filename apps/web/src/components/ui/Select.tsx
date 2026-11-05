import type { ReactNode, SelectHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

const controlClass = cn(
  'h-11 w-full rounded-control border border-senda-border bg-white px-3.5 text-sm text-senda-ink shadow-sm',
  'transition hover:border-senda-border-strong',
  'focus:border-senda-navy/40 focus:outline-none focus:ring-2 focus:ring-senda-orange/25',
  'disabled:cursor-not-allowed disabled:bg-senda-subtle',
)

export function Select({
  label,
  value,
  onChange,
  children,
  disabled,
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  children: ReactNode
  disabled?: boolean
  className?: string
}) {
  return (
    <label className={cn('block space-y-1.5 text-xs font-semibold text-senda-muted', className)}>
      {label}
      <select
        className={controlClass}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Seleccionar…</option>
        {children}
      </select>
    </label>
  )
}

export function SelectControl({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(controlClass, className)} {...props}>
      {children}
    </select>
  )
}
