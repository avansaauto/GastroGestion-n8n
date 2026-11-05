import { ChartNoAxesCombined, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { PageHeader } from '@/components/ui/PageHeader'
import {
  getSaleConsumptions,
  type SaleConsumptionGroup,
  type SaleConsumptionLineStatus,
  type SaleConsumptionStatus,
} from '@/lib/api'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useAuth } from '@/lib/auth'
import { formatInventoryStock } from '@/lib/inventoryCatalog'
import { formatQuantity } from '@/lib/invoices/review'
import { cn } from '@/lib/utils'

const UNKNOWN = 'No consta'

const STATUS_LABEL: Record<SaleConsumptionStatus, string> = {
  registered: 'Registrado',
  reversed: 'Revertido',
  complete: 'Completo',
  partial: 'Parcial',
  failed: 'Fallido',
  duplicate: 'Ya procesado',
}

const LINE_STATUS_LABEL: Record<SaleConsumptionLineStatus, string> = {
  registered: 'Registrado',
  reversed: 'Revertido',
  failed: 'Fallido',
  duplicate: 'Duplicado',
}

const STATUS_FILTERS: Array<{ id: 'all' | SaleConsumptionStatus; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'complete', label: 'Completo' },
  { id: 'partial', label: 'Parcial' },
  { id: 'failed', label: 'Fallido' },
  { id: 'registered', label: 'Registrado' },
  { id: 'reversed', label: 'Revertido' },
  { id: 'duplicate', label: 'Duplicado' },
]

function statusTone(status: SaleConsumptionStatus): BadgeTone {
  if (status === 'complete' || status === 'registered' || status === 'duplicate') return 'success'
  if (status === 'partial') return 'warning'
  if (status === 'failed' || status === 'reversed') return 'danger'
  return 'neutral'
}

function formatWhen(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date)
}

function quantityLabel(quantity: number, baseUnit: string | null) {
  return formatInventoryStock(quantity, baseUnit, formatQuantity)
}

function channelLabel(sourceType: string) {
  if (sourceType === 'fudo') return 'Fudo'
  if (isTestSource(sourceType)) return 'Prueba'
  return sourceType
}

export function isTestSource(sourceType: string) {
  const key = sourceType.trim().toLowerCase()
  return key.includes('senda_test') || key.includes('test') || key.startsWith('fixture')
}

function soldProductLabel(group: SaleConsumptionGroup) {
  return group.soldProductName?.trim() || UNKNOWN
}

function recipeLabel(group: SaleConsumptionGroup) {
  return group.recipeName?.trim() || UNKNOWN
}

function dayKey(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

export function filterSaleConsumptionGroups(
  groups: SaleConsumptionGroup[],
  options: {
    query: string
    status: 'all' | SaleConsumptionStatus
    source: 'all' | 'fudo' | 'other' | 'test'
    date: string
    includeTests: boolean
  },
) {
  const q = options.query.trim().toLowerCase()
  return groups.filter((group) => {
    const test = isTestSource(group.sourceType)
    if (!options.includeTests && test) return false
    if (options.source === 'fudo' && group.sourceType !== 'fudo') return false
    if (options.source === 'test' && !test) return false
    if (options.source === 'other' && (group.sourceType === 'fudo' || test)) return false
    if (options.status !== 'all' && group.status !== options.status) return false
    if (options.date && dayKey(group.occurredAt) !== options.date) return false
    if (!q) return true
    const haystack = [
      group.sourceId,
      group.sourceType,
      soldProductLabel(group),
      recipeLabel(group),
      ...group.lines.map((line) => line.productName),
    ].join(' ').toLowerCase()
    return haystack.includes(q)
  })
}

export function SalesConsumptionBoard({
  loading,
  error,
  groups,
  selectedKey,
  onSelect,
}: {
  loading: boolean
  error: string
  groups: SaleConsumptionGroup[]
  selectedKey: string
  onSelect: (key: string) => void
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | SaleConsumptionStatus>('all')
  const [source, setSource] = useState<'all' | 'fudo' | 'other' | 'test'>('all')
  const [date, setDate] = useState('')
  const [includeTests, setIncludeTests] = useState(false)

  const visible = useMemo(
    () => filterSaleConsumptionGroups(groups, { query, status, source, date, includeTests }),
    [groups, query, status, source, date, includeTests],
  )
  const hiddenTests = groups.filter((group) => isTestSource(group.sourceType)).length
  const selected = visible.find((group) => `${group.sourceType}:${group.sourceId}` === selectedKey) ?? null

  if (loading) {
    return <p className="mb-0 text-sm text-senda-muted">Cargando consumos…</p>
  }
  if (error) {
    return <p className="mb-0 text-sm text-red-700" role="alert">{error}</p>
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr_1fr]">
          <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
            Buscar
            <span className="relative block">
              <Search className="absolute left-3 top-3 text-slate-400" size={17} />
              <Input
                className="pl-9"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Referencia, producto, receta…"
                value={query}
              />
            </span>
          </label>
          <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
            Origen
            <select
              className="h-11 w-full rounded-lg border border-senda-border bg-white px-3 text-sm text-senda-ink"
              onChange={(event) => setSource(event.target.value as typeof source)}
              value={source}
            >
              <option value="all">Todos</option>
              <option value="fudo">Fudo</option>
              <option value="other">Otros</option>
              <option value="test">Solo pruebas</option>
            </select>
          </label>
          <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
            Fecha
            <Input onChange={(event) => setDate(event.target.value)} type="date" value={date} />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((option) => (
            <button
              className={cn(
                'inline-flex min-h-9 items-center rounded-full px-3 text-sm font-semibold transition',
                status === option.id
                  ? 'bg-senda-navy text-white'
                  : 'border border-senda-border bg-white text-senda-ink hover:bg-senda-subtle',
              )}
              key={option.id}
              onClick={() => setStatus(option.id)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        {hiddenTests > 0 || includeTests ? (
          <label className="flex items-center gap-2 text-xs text-senda-muted">
            <input
              checked={includeTests}
              onChange={(event) => setIncludeTests(event.target.checked)}
              type="checkbox"
            />
            Mostrar eventos de prueba ({hiddenTests})
          </label>
        ) : null}
      </Card>

      {groups.length === 0 ? (
        <Card>
          <EmptyState
            icon={ChartNoAxesCombined}
            title="Sin consumos registrados"
            description="Cuando n8n registre una venta de Fudo, el consumo de esta sucursal va a aparecer acá."
          />
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            compact
            icon={Search}
            title="Sin resultados"
            description="Ajustá los filtros o incluí eventos de prueba si los estás buscando."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-senda-border bg-senda-subtle/70 text-xs uppercase tracking-wide text-senda-muted">
                  {['Referencia', 'Fecha', 'Producto vendido', 'Receta', 'Insumos', 'Cantidad', 'Estado', ''].map((label) => (
                    <th className="px-4 py-3 font-semibold" key={label || 'detalle'}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((group) => {
                  const key = `${group.sourceType}:${group.sourceId}`
                  const test = isTestSource(group.sourceType)
                  const quantity = group.lines.length === 1
                    ? quantityLabel(group.lines[0]!.quantity, group.lines[0]!.baseUnit)
                    : group.lines.length > 0
                      ? `${group.lines.length} insumos`
                      : '—'
                  return (
                    <tr
                      className={cn(
                        'border-b border-senda-border last:border-0',
                        test && 'bg-senda-subtle/40 text-senda-muted',
                      )}
                      key={key}
                    >
                      <td className="px-4 py-3">
                        <p className="mb-0 font-semibold text-senda-ink">{group.sourceId}</p>
                        <p className="mb-0 text-xs text-senda-muted">
                          {channelLabel(group.sourceType)}
                          {test ? ' · prueba' : ''}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-senda-muted">{formatWhen(group.occurredAt)}</td>
                      <td className="px-4 py-3 font-medium text-senda-ink">{soldProductLabel(group)}</td>
                      <td className="px-4 py-3 text-senda-muted">{recipeLabel(group)}</td>
                      <td className="px-4 py-3 text-senda-muted">
                        {group.lines.length > 0
                          ? group.lines.map((line) => line.productName).join(', ')
                          : '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">{quantity}</td>
                      <td className="px-4 py-3">
                        <Badge tone={statusTone(group.status)}>{STATUS_LABEL[group.status]}</Badge>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          className="text-sm font-semibold text-senda-navy hover:underline"
                          onClick={() => onSelect(key)}
                          type="button"
                        >
                          Ver detalle
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        open={Boolean(selected)}
        title={selected ? `Detalle · ${selected.sourceId}` : 'Detalle'}
        onClose={() => onSelect('')}
      >
        {selected ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(selected.status)}>{STATUS_LABEL[selected.status]}</Badge>
              <Badge tone={isTestSource(selected.sourceType) ? 'warning' : 'neutral'}>
                {channelLabel(selected.sourceType)}
              </Badge>
            </div>
            <dl className="m-0 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Producto</dt>
                <dd className="mb-0 mt-1 font-semibold">{soldProductLabel(selected)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Receta</dt>
                <dd className="mb-0 mt-1">{recipeLabel(selected)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Fecha</dt>
                <dd className="mb-0 mt-1">{formatWhen(selected.occurredAt)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-senda-muted">Vendido</dt>
                <dd className="mb-0 mt-1">
                  {selected.soldQuantity != null
                    ? `${formatQuantity(selected.soldQuantity)}${selected.soldUnit ? ` ${selected.soldUnit}` : ''}`
                    : '—'}
                </dd>
              </div>
            </dl>
            {selected.lines.length === 0 ? (
              <p className="mb-0 text-sm text-senda-muted">Sin líneas de consumo asociadas.</p>
            ) : (
              <ul className="mb-0 list-none space-y-2 p-0">
                {selected.lines.map((line) => (
                  <li
                    className="flex flex-col gap-1 rounded-xl border border-senda-border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                    key={line.id}
                  >
                    <span className="font-semibold">{line.productName}</span>
                    <span className="text-sm text-senda-muted">
                      {quantityLabel(line.quantity, line.baseUnit)}
                      {' · '}
                      {LINE_STATUS_LABEL[line.status]}
                      {line.errorCode ? ` · ${line.errorCode}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <button
              className="inline-flex items-center gap-1 text-sm font-semibold text-senda-muted hover:text-senda-ink"
              onClick={() => onSelect('')}
              type="button"
            >
              <X size={14} /> Cerrar
            </button>
          </div>
        ) : null}
      </Modal>

      <p className="mb-0 text-xs text-senda-muted">
        Consultar esta lista no descuenta stock. Los eventos de prueba quedan ocultos por defecto.
      </p>
    </div>
  )
}

export function SalesConsumptionsPage() {
  const { previewMode } = useAuth()
  const { organizationId, locationId, error: scopeError } = useAuthorizedScopeContext()
  const scopeKey = `${organizationId}::${locationId}`
  const [load, setLoad] = useState<{ key: string; groups: SaleConsumptionGroup[]; error: string }>({
    key: '',
    groups: [],
    error: '',
  })
  const [selectedKey, setSelectedKey] = useState('')

  useEffect(() => {
    if (previewMode || !organizationId || !locationId) return
    const key = `${organizationId}::${locationId}`
    let active = true
    getSaleConsumptions(organizationId, locationId)
      .then((groups) => {
        if (!active) return
        setLoad({ key, groups, error: '' })
      })
      .catch((reason: Error) => {
        if (!active) return
        setLoad({ key, groups: [], error: reason.message })
      })
    return () => {
      active = false
    }
  }, [locationId, organizationId, previewMode])

  if (previewMode) {
    return (
      <Card>
        <EmptyState
          title="Ventas y consumos"
          description="Configurá Supabase para consultar los consumos ya registrados. Esta pantalla no descuenta stock."
        />
      </Card>
    )
  }

  const ready = load.key === scopeKey
  const groups = ready ? load.groups : []

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ventas y consumos"
        description="Consumos que Fudo ya envió por n8n para esta sucursal. Consultar no vuelve a descontar stock."
      />
      <SalesConsumptionBoard
        error={ready ? load.error || scopeError : scopeError}
        groups={groups}
        loading={Boolean(organizationId && locationId) && !ready && !scopeError}
        onSelect={setSelectedKey}
        selectedKey={selectedKey}
      />
    </div>
  )
}
