import { FileUp, X } from 'lucide-react'
import { useRef, useState, type DragEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { formatFileKind, formatFileSize } from '@/lib/invoices/file'
import { INVOICE_ACCEPT_ATTR } from '@/lib/invoices/constants'
import type { SelectedInvoiceFile } from '@/lib/invoices/types'

export function InvoiceDropzone({
  file,
  error,
  disabled,
  onSelect,
  onClear,
}: {
  file: SelectedInvoiceFile | null
  error: string | null
  disabled?: boolean
  onSelect: (file: File) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  function takeFile(list: FileList | null) {
    const next = list?.[0]
    if (next) onSelect(next)
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragOver(false)
    if (!disabled) takeFile(event.dataTransfer.files)
  }

  return (
    <div className="space-y-3">
      <div
        className={`rounded-2xl border border-dashed px-6 py-10 text-center transition ${
          dragOver ? 'border-senda-orange bg-orange-50' : 'border-senda-border bg-senda-subtle/60'
        } ${disabled ? 'opacity-60' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          if (!disabled) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <FileUp className="mx-auto text-senda-muted" size={28} />
        <p className="mb-1 mt-3 text-sm font-semibold">Arrastrá un comprobante o seleccionalo</p>
        <p className="m-0 text-xs text-senda-muted">PDF, JPG, PNG o WebP · un archivo · máximo 10 MB</p>
        <Button
          className="mt-5"
          disabled={disabled}
          variant="secondary"
          onClick={() => inputRef.current?.click()}
        >
          Seleccionar archivo
        </Button>
        <input
          ref={inputRef}
          accept={INVOICE_ACCEPT_ATTR}
          className="sr-only"
          disabled={disabled}
          type="file"
          onChange={(event) => {
            takeFile(event.target.files)
            event.currentTarget.value = ''
          }}
        />
      </div>

      {file && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-senda-border bg-white px-4 py-3">
          <div>
            <p className="m-0 text-sm font-semibold">{file.name}</p>
            <p className="mb-0 mt-1 text-xs text-senda-muted">
              {formatFileKind(file.name, file.type)} · {formatFileSize(file.size)}
            </p>
          </div>
          <div className="flex gap-2">
            <Button disabled={disabled} variant="secondary" onClick={() => inputRef.current?.click()}>
              Reemplazar
            </Button>
            <Button aria-label="Quitar archivo" disabled={disabled} variant="ghost" onClick={onClear}>
              <X size={16} /> Quitar
            </Button>
          </div>
        </div>
      )}

      {error && <p className="m-0 text-sm text-red-700">{error}</p>}
    </div>
  )
}
