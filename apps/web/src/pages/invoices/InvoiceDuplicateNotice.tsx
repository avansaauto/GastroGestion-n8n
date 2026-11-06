import { Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  DUPLICATE_CHECKING_MESSAGE,
  DUPLICATE_LOOKUP_FAILED_MESSAGE,
  DUPLICATE_OPEN_LABEL,
  DUPLICATE_REGISTERED_TITLE,
  type InvoiceDuplicateState,
} from '@/lib/invoices/invoiceDuplicate'
import { formatIssueDate } from '@/lib/invoices/review'

export function InvoiceDuplicateNotice({ duplicate }: { duplicate: InvoiceDuplicateState }) {
  if (duplicate.status === 'checking') {
    return (
      <div className="mt-5 flex items-start gap-3 rounded-xl border border-senda-border bg-senda-subtle px-4 py-3">
        <Loader2 className="mt-0.5 animate-spin text-senda-navy" size={18} />
        <p className="mb-0 text-sm font-semibold">{DUPLICATE_CHECKING_MESSAGE}</p>
      </div>
    )
  }

  if (duplicate.status === 'failed' && duplicate.warning) {
    return (
      <div className="mt-5 rounded-xl border border-senda-border bg-senda-subtle px-4 py-3 text-sm text-senda-ink">
        {duplicate.warning || DUPLICATE_LOOKUP_FAILED_MESSAGE}
      </div>
    )
  }

  if (duplicate.status === 'noted' || duplicate.status === 'idle' || duplicate.status === 'clear') {
    return null
  }

  if (duplicate.status !== 'matched' || !duplicate.match) return null

  const { supplierName, documentNumber, documentDate, id } = duplicate.match

  return (
    <div className="mt-5 rounded-xl border border-senda-border bg-senda-subtle px-4 py-4">
      <p className="m-0 text-sm font-semibold">{DUPLICATE_REGISTERED_TITLE}</p>
      {(supplierName || documentNumber || documentDate) && (
        <p className="mb-0 mt-2 text-sm text-senda-muted">
          {[supplierName, documentNumber, formatIssueDate(documentDate)].filter((part) => part && part !== '—').join(' · ')}
        </p>
      )}
      <p className="mb-0 mt-3 text-sm">
        <Link className="font-semibold text-senda-navy hover:underline" to={`/facturas/${id}`}>
          {DUPLICATE_OPEN_LABEL}
        </Link>
      </p>
    </div>
  )
}
