import type { ReactNode } from 'react'
import { zIndex } from '@/design-system/zIndex'
import { Button } from './Button'

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
}) {
  if (!open) return null

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 flex items-end justify-center p-3 sm:items-center"
      role="dialog"
      style={{ zIndex: zIndex.dialog }}
    >
      <button
        aria-label="Cerrar"
        className="absolute inset-0 bg-senda-ink/40"
        style={{ zIndex: zIndex.overlay }}
        type="button"
        onClick={onClose}
      />
      <div
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-panel"
        style={{ zIndex: zIndex.dialog }}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="m-0 text-base font-bold">{title}</h3>
          <Button className="min-h-8 px-3 text-xs" variant="ghost" onClick={onClose}>
            Cerrar
          </Button>
        </div>
        {children}
      </div>
    </div>
  )
}
