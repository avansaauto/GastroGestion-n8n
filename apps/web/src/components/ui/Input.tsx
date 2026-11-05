import type { InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-11 w-full rounded-control border border-senda-border bg-white px-3.5 text-sm text-senda-ink shadow-sm',
        'placeholder:text-slate-400',
        'transition hover:border-senda-border-strong',
        'focus:border-senda-navy/40 focus:outline-none focus:ring-2 focus:ring-senda-orange/25',
        'disabled:cursor-not-allowed disabled:bg-senda-subtle disabled:text-senda-muted',
        className,
      )}
      {...props}
    />
  )
}
