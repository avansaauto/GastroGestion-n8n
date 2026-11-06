import { Camera, Expand, FileText, FileUp, X } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { formatFileKind, formatFileSize } from '@/lib/invoices/file'
import { INVOICE_ACCEPT_ATTR } from '@/lib/invoices/constants'
import type { SelectedInvoiceFile } from '@/lib/invoices/types'

function FilePreview({ file }: { file: SelectedInvoiceFile }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const next = URL.createObjectURL(file.file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])

  if (!url) return null
  const isImage = file.type.startsWith('image/')
  const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')

  return (
    <div className="overflow-hidden rounded-2xl border border-senda-border bg-[#f7f5f2]">
      <div className="flex items-center justify-between gap-3 border-b border-senda-border bg-white px-3 py-2.5">
        <p className="m-0 text-xs font-semibold uppercase tracking-[0.06em] text-senda-muted">Vista previa</p>
        <a
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-senda-navy hover:underline"
          href={url}
          rel="noreferrer"
          target="_blank"
        >
          <Expand size={15} /> Ampliar
        </a>
      </div>
      <div className="p-2 sm:p-3">
        {isImage ? (
          <img alt="" className="mx-auto max-h-[72dvh] min-h-64 w-full rounded-xl bg-white object-contain lg:min-h-[28rem]" src={url} />
        ) : isPdf ? (
          <object className="h-[min(72dvh,40rem)] min-h-72 w-full rounded-xl bg-white" data={url} type="application/pdf">
            <a className="block px-4 py-8 text-center text-sm font-semibold text-senda-navy" href={url} rel="noreferrer" target="_blank">
              Abrir PDF
            </a>
          </object>
        ) : (
          <a className="block px-4 py-8 text-center text-sm font-semibold text-senda-navy" href={url} rel="noreferrer" target="_blank">
            Abrir comprobante
          </a>
        )}
      </div>
    </div>
  )
}

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
  const cameraRef = useRef<HTMLInputElement>(null)
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

  const dragProps = {
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      if (!disabled) setDragOver(true)
    },
    onDragLeave: () => setDragOver(false),
    onDrop,
  }

  return (
    <div className="space-y-3">
      {!file ? (
        <div
          className={`rounded-2xl border-2 border-dashed px-4 py-8 text-center transition sm:px-8 sm:py-10 ${
            dragOver ? 'border-senda-orange bg-orange-50' : 'border-senda-border bg-gradient-to-b from-white to-senda-subtle'
          } ${disabled ? 'opacity-60' : ''}`}
          {...dragProps}
        >
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white text-senda-orange shadow-sm ring-1 ring-orange-100">
            <FileUp size={26} />
          </span>
          <p className="mb-1 mt-4 text-base font-extrabold tracking-tight">Subí la factura</p>
          <p className="mx-auto m-0 max-w-md text-sm leading-6 text-senda-muted">
            Arrastrá un comprobante o elegilo del dispositivo. Aceptamos imagen o PDF.
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            {['PDF', 'JPG', 'PNG', 'WebP'].map((kind) => (
              <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold tracking-wide text-senda-ink ring-1 ring-senda-border" key={kind}>
                {kind}
              </span>
            ))}
            <span className="rounded-full bg-senda-subtle px-2.5 py-1 text-[11px] font-semibold text-senda-muted">máximo 10 MB</span>
          </div>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <Button className="min-h-11" disabled={disabled} onClick={() => inputRef.current?.click()}>
              Subir factura
            </Button>
            <Button className="min-h-11" disabled={disabled} variant="secondary" onClick={() => cameraRef.current?.click()}>
              <Camera size={16} /> Tomar foto
            </Button>
          </div>
        </div>
      ) : (
        <div
          className={`space-y-3 rounded-2xl border bg-white p-3 sm:p-4 ${dragOver ? 'border-senda-orange ring-2 ring-orange-200' : 'border-senda-border'}`}
          {...dragProps}
        >
          <FilePreview file={file} />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-start gap-2">
              <FileText className="mt-0.5 shrink-0 text-senda-orange" size={16} />
              <div className="min-w-0">
                <p className="m-0 truncate text-sm font-semibold">{file.name}</p>
                <p className="mb-0 mt-1 text-xs text-senda-muted">
                  {formatFileKind(file.name, file.type)} · {formatFileSize(file.size)}
                </p>
              </div>
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button className="min-h-11 flex-1 sm:flex-none" disabled={disabled} variant="secondary" onClick={() => inputRef.current?.click()}>
                Cambiar archivo
              </Button>
              <Button aria-label="Quitar archivo" className="min-h-11" disabled={disabled} variant="ghost" onClick={onClear}>
                <X size={16} /> Quitar
              </Button>
            </div>
          </div>
        </div>
      )}

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
      <input
        ref={cameraRef}
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="sr-only"
        disabled={disabled}
        type="file"
        onChange={(event) => {
          takeFile(event.target.files)
          event.currentTarget.value = ''
        }}
      />

      {error && (
        <p className="m-0 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}
    </div>
  )
}
