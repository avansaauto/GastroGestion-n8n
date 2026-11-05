import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

export function Button({
  children,
  className,
  variant = 'primary',
  size = 'md',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode
  variant?: Variant
  size?: Size
}) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-control text-sm font-semibold transition',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' && 'min-h-8 px-3 text-xs',
        size === 'md' && 'min-h-10 px-4',
        size === 'lg' && 'min-h-11 px-5 text-[15px]',
        variant === 'primary' && 'bg-senda-navy text-white shadow-sm hover:bg-[#132a45]',
        variant === 'secondary' && 'border border-senda-border-strong bg-white text-senda-ink hover:bg-senda-subtle',
        variant === 'ghost' && 'text-senda-muted hover:bg-senda-subtle hover:text-senda-ink',
        variant === 'danger' && 'bg-red-600 text-white hover:bg-red-700',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
