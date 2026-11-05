import {
  AlertTriangle,
  ArrowRight,
  Boxes,
  ClipboardCheck,
  FileText,
  History,
  Loader2,
  PackageMinus,
  UtensilsCrossed,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, type BadgeTone } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import {
  getFudoCatalog,
  getInventoryMovements,
  getInventoryProducts,
  getLocationRecipes,
  getPendingProducts,
  type InventoryMovement,
  type InventoryProduct,
  type PendingProduct,
} from '@/lib/api'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useAuth } from '@/lib/auth'
import {
  formatInventoryStock,
  inventoryLowStockProducts,
  inventoryProductsActiveOnly,
} from '@/lib/inventoryCatalog'
import { formatQuantity } from '@/lib/invoices/review'
import { mergeFudoPickerProducts } from '@/lib/fudoProductPicker'
import {
  OVERVIEW_FUDO_CATALOG_NOTE,
  OVERVIEW_FUDO_COVERAGE_NOTE,
  summarizeOverviewFudoMetrics,
  type OverviewFudoMetrics,
} from '@/lib/overviewFudoMetrics'
import { locationName } from '@/lib/operations'
import { cn } from '@/lib/utils'

type OverviewState = {
  products: InventoryProduct[]
  fudoProducts: PendingProduct[]
  recipes: number | null
  movements: InventoryMovement[]
  error: string
  loading: boolean
  fudoLoaded: boolean
}

const emptyFudoMetrics: OverviewFudoMetrics = {
  detectedTotal: 0,
  pendingDetected: 0,
  withoutActiveLink: 0,
  linked: 0,
  catalogSynced: 0,
  catalogActive: 0,
  catalogUnlinkedActive: 0,
  hasCatalog: false,
}

function formatWhen(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('es-AR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function movementTone(label: string): BadgeTone {
  const key = label.toLowerCase()
  if (key.includes('compra')) return 'success'
  if (key.includes('merma')) return 'warning'
  if (key.includes('anul')) return 'danger'
  if (key.includes('consumo') || key.includes('venta')) return 'info'
  return 'neutral'
}

export function OverviewPage() {
  const { previewMode } = useAuth()
  const { organizationId, locationId, location, error: scopeError } = useAuthorizedScopeContext()
  const [state, setState] = useState<OverviewState>({
    products: [],
    fudoProducts: [],
    recipes: null,
    movements: [],
    error: '',
    loading: false,
    fudoLoaded: false,
  })

  useEffect(() => {
    if (previewMode || !organizationId || !locationId) {
      setState({
        products: [],
        fudoProducts: [],
        recipes: null,
        movements: [],
        error: '',
        loading: false,
        fudoLoaded: false,
      })
      return
    }

    let active = true
    setState((current) => ({ ...current, loading: true, error: '' }))

    Promise.allSettled([
      getInventoryProducts(organizationId, { locationId }),
      Promise.all([
        getFudoCatalog(locationId).catch(() => [] as PendingProduct[]),
        getPendingProducts(locationId),
      ]).then(([catalog, historical]) => mergeFudoPickerProducts(catalog, historical)),
      getLocationRecipes(locationId),
      getInventoryMovements(organizationId, locationId, { page: 1 }),
    ]).then((results) => {
      if (!active) return
      const [productsResult, fudoResult, recipesResult, movementsResult] = results
      setState({
        products: productsResult.status === 'fulfilled'
          ? inventoryProductsActiveOnly(productsResult.value)
          : [],
        fudoProducts: fudoResult.status === 'fulfilled' ? fudoResult.value : [],
        fudoLoaded: fudoResult.status === 'fulfilled',
        recipes: recipesResult.status === 'fulfilled'
          ? recipesResult.value.filter((row) => row.active !== false).length
          : null,
        movements: movementsResult.status === 'fulfilled'
          ? (Array.isArray(movementsResult.value.items) ? movementsResult.value.items.slice(0, 10) : [])
          : [],
        error: results.some((row) => row.status === 'rejected')
          ? 'Algunas métricas no se pudieron actualizar.'
          : '',
        loading: false,
      })
    })

    return () => {
      active = false
    }
  }, [organizationId, locationId, previewMode])

  const lowStock = useMemo(() => inventoryLowStockProducts(state.products), [state.products])
  const productCount = state.loading ? null : state.products.length
  const fudoMetrics = useMemo(
    () => (state.fudoLoaded ? summarizeOverviewFudoMetrics(state.fudoProducts) : emptyFudoMetrics),
    [state.fudoLoaded, state.fudoProducts],
  )
  const fudoCount = (value: number) => (state.loading || !state.fudoLoaded ? null : value)

  const attentionItems = useMemo(() => {
    const items: Array<{
      key: string
      title: string
      detail: string
      to: string
      tone: 'warning' | 'danger' | 'info'
    }> = []
    if (state.fudoLoaded && fudoMetrics.withoutActiveLink > 0) {
      const n = fudoMetrics.withoutActiveLink
      items.push({
        key: 'fudo-unlinked',
        title: `${n} producto${n === 1 ? '' : 's'} Fudo sin vinculación activa`,
        detail: [
          fudoMetrics.pendingDetected > 0
            ? `${fudoMetrics.pendingDetected} pendiente${fudoMetrics.pendingDetected === 1 ? '' : 's'} detectado${fudoMetrics.pendingDetected === 1 ? '' : 's'} en ventas`
            : null,
          fudoMetrics.withoutActiveLink > fudoMetrics.pendingDetected
            ? `${fudoMetrics.withoutActiveLink - fudoMetrics.pendingDetected} resolved sin mapping`
            : null,
          'No es el catálogo Fudo completo',
        ].filter(Boolean).join(' · '),
        to: '/recetas',
        tone: 'warning',
      })
    }
    if (lowStock.length > 0) {
      items.push({
        key: 'low',
        title: `${lowStock.length} insumo${lowStock.length === 1 ? '' : 's'} bajo mínimo`,
        detail: lowStock.slice(0, 2).map((row) => row.name).join(' · ')
          + (lowStock.length > 2 ? ` · +${lowStock.length - 2}` : ''),
        to: '/inventario',
        tone: 'danger',
      })
    }
    return items
  }, [state.fudoLoaded, fudoMetrics, lowStock])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Resumen operativo"
        description={
          location
            ? `Prioridades y actividad de ${locationName(location)}.`
            : 'Prioridades y actividad del local activo.'
        }
        actions={(
          <div className="flex flex-wrap gap-2">
            <Link to="/facturas/nueva"><Button size="sm">Nueva factura</Button></Link>
            <Link to="/recetas/crear"><Button size="sm" variant="secondary">Nueva receta</Button></Link>
          </div>
        )}
      />

      {(scopeError || state.error) && (
        <div className="rounded-control border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-950" role="status">
          {scopeError || state.error}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-12">
        <Card className="xl:col-span-5">
          <CardHeader
            title="Requiere atención"
            description="Lo que conviene resolver primero en el local"
          />
          <div className="p-4">
            {state.loading ? (
              <div className="flex min-h-36 items-center justify-center gap-2 text-sm text-senda-muted">
                <Loader2 className="animate-spin" size={16} /> Actualizando…
              </div>
            ) : attentionItems.length === 0 ? (
              <div className="rounded-control border border-emerald-200 bg-emerald-50/70 px-4 py-5">
                <p className="m-0 text-sm font-semibold text-emerald-950">Sin bloqueos operativos</p>
                <p className="mb-0 mt-1 text-xs leading-5 text-emerald-900/80">
                  No hay productos Fudo conocidos sin vínculo ni stock bajo mínimo en este momento.
                </p>
              </div>
            ) : (
              <ul className="m-0 list-none space-y-2 p-0">
                {attentionItems.map((item) => (
                  <li key={item.key}>
                    <Link
                      className={cn(
                        'flex items-start justify-between gap-3 rounded-control border px-3.5 py-3 transition hover:shadow-sm',
                        item.tone === 'danger' && 'border-red-200 bg-red-50/80',
                        item.tone === 'warning' && 'border-orange-200 bg-orange-50/80',
                        item.tone === 'info' && 'border-sky-200 bg-sky-50/80',
                      )}
                      to={item.to}
                    >
                      <div className="min-w-0">
                        <p className="mb-0 text-sm font-semibold text-senda-ink">{item.title}</p>
                        <p className="mb-0 mt-1 text-xs leading-5 text-senda-muted">{item.detail}</p>
                      </div>
                      <ArrowRight className="mt-0.5 shrink-0 text-senda-muted" size={16} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <div className="grid gap-3 sm:grid-cols-3 xl:col-span-7 xl:grid-cols-3">
          <MetricTile
            href="/inventario"
            icon={Boxes}
            label="Inventario activo"
            value={productCount}
            loading={state.loading}
            emphasis
          />
          <MetricTile
            href="/recetas"
            icon={ClipboardCheck}
            label="Recetas"
            value={state.recipes}
            loading={state.loading}
          />
          <MetricTile
            href="/recetas"
            icon={AlertTriangle}
            label="Pendientes Fudo detectados"
            value={fudoCount(fudoMetrics.pendingDetected)}
            loading={state.loading}
            warn={(fudoMetrics.pendingDetected ?? 0) > 0 && state.fudoLoaded}
          />
          <div className="sm:col-span-3">
            <Card className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="m-0 text-xs font-semibold uppercase tracking-[0.06em] text-senda-muted">
                    {fudoMetrics.hasCatalog ? 'Catálogo Fudo' : 'Cobertura Fudo (detecciones)'}
                  </p>
                  <p className="mb-0 mt-1 text-xs text-senda-muted">
                    {fudoMetrics.hasCatalog ? OVERVIEW_FUDO_CATALOG_NOTE : OVERVIEW_FUDO_COVERAGE_NOTE}
                  </p>
                </div>
                <Link
                  className="text-xs font-semibold text-senda-navy hover:underline"
                  to="/recetas"
                >
                  Ir a recetas
                </Link>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <FudoStat
                  label={fudoMetrics.hasCatalog ? 'Catálogo sincronizado' : 'Pendientes detectados'}
                  value={fudoCount(fudoMetrics.hasCatalog ? fudoMetrics.catalogSynced : fudoMetrics.pendingDetected)}
                  loading={state.loading}
                  tone="warning"
                />
                <FudoStat
                  label="Sin vinculación activa"
                  value={fudoCount(
                    fudoMetrics.hasCatalog
                      ? fudoMetrics.catalogUnlinkedActive
                      : fudoMetrics.withoutActiveLink,
                  )}
                  loading={state.loading}
                  tone="danger"
                />
                <FudoStat
                  label="Vinculados"
                  value={fudoCount(fudoMetrics.linked)}
                  loading={state.loading}
                  tone="success"
                />
              </div>
              {state.fudoLoaded && !state.loading ? (
                <p className="mb-0 mt-3 text-[11px] text-senda-muted">
                  {fudoMetrics.detectedTotal} producto{fudoMetrics.detectedTotal === 1 ? '' : 's'} Fudo
                  {' '}conocido{fudoMetrics.detectedTotal === 1 ? '' : 's'} por ventas en este local.
                </p>
              ) : null}
            </Card>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:col-span-3">
            <QuickChip href="/facturas/nueva" icon={FileText} label="Factura" />
            <QuickChip href="/recetas/crear" icon={UtensilsCrossed} label="Receta" />
            <QuickChip href="/historial" icon={History} label="Historial" />
          </div>
        </div>

        <Card className="xl:col-span-8">
          <CardHeader
            title="Actividad reciente"
            description="Últimos movimientos del inventario"
            action={(
              <Link className="inline-flex items-center gap-1 text-sm font-semibold text-senda-navy hover:underline" to="/historial">
                Ver historial <ArrowRight size={14} />
              </Link>
            )}
          />
          {state.loading ? (
            <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-senda-muted">
              <Loader2 className="animate-spin" size={16} /> Cargando actividad…
            </div>
          ) : state.movements.length === 0 ? (
            <EmptyState
              compact
              icon={PackageMinus}
              title="Todavía no hay movimientos"
              description="Compras, consumos, mermas y ajustes del local van a listarse acá."
            />
          ) : (
            <ul className="m-0 list-none divide-y divide-senda-border p-0">
              {state.movements.map((row) => (
                <li className="grid grid-cols-[1fr_auto] gap-3 px-5 py-3 sm:grid-cols-[7rem_1fr_auto_auto]" key={row.id}>
                  <p className="mb-0 text-xs text-senda-muted sm:pt-0.5">{formatWhen(row.occurredAt)}</p>
                  <div className="min-w-0 sm:col-auto">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="mb-0 truncate text-sm font-semibold text-senda-ink">{row.productName}</p>
                      <Badge tone={movementTone(row.label)}>{row.label}</Badge>
                      {row.productActive === false ? (
                        <span className="text-[11px] text-senda-muted">Eliminado</span>
                      ) : null}
                    </div>
                    {row.detail?.trim() ? (
                      <p className="mb-0 mt-1 truncate text-xs text-senda-muted">{row.detail}</p>
                    ) : null}
                  </div>
                  <p className="mb-0 text-right text-sm font-semibold tabular-nums text-senda-ink">
                    {formatInventoryStock(row.quantity, row.baseUnit, formatQuantity)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="xl:col-span-4">
          <CardHeader title="Plataforma" description="Estado resumido" />
          <div className="space-y-2 p-4">
            <PlatformRow label="Fudo → consumos" value="Operativo" tone="success" />
            <PlatformRow
              label="Catálogo Fudo"
              value={fudoMetrics.hasCatalog ? 'Sincronizado' : 'Solo ventas'}
              tone={fudoMetrics.hasCatalog ? 'success' : 'warning'}
            />
            <PlatformRow label="Supabase" value="En uso" tone="success" />
            <p className="mb-0 mt-1 text-[11px] leading-4 text-senda-muted">
              {fudoMetrics.hasCatalog
                ? `${fudoMetrics.catalogActive} activos en catálogo · ${fudoMetrics.linked} vinculados. La sync automática no está encendida.`
                : 'El catálogo completo de Fudo todavía no está sincronizado; solo hay detecciones por ventas.'}
            </p>
            <Link to="/configuracion" className="mt-2 block">
              <Button className="w-full" size="sm" variant="secondary">Configuración</Button>
            </Link>
          </div>
        </Card>
      </div>
    </div>
  )
}

function MetricTile({
  href,
  icon: Icon,
  label,
  value,
  loading,
  emphasis = false,
  warn = false,
}: {
  href: string
  icon: typeof Boxes
  label: string
  value: number | null
  loading: boolean
  emphasis?: boolean
  warn?: boolean
}) {
  return (
    <Link to={href} className={cn(emphasis && 'sm:col-span-1')}>
      <Card
        className={cn(
          'h-full p-4 transition hover:border-senda-navy/25 hover:shadow-raised',
          emphasis && 'border-senda-navy/15 bg-gradient-to-br from-white to-orange-50/40',
          warn && 'border-orange-200',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.06em] text-senda-muted">{label}</p>
          <span className={cn('rounded-control p-2', warn ? 'bg-orange-100 text-senda-orange' : 'bg-senda-subtle text-senda-navy')}>
            <Icon size={16} />
          </span>
        </div>
        <p className={cn('mb-0 mt-4 font-extrabold tracking-tight text-senda-ink', emphasis ? 'text-4xl' : 'text-3xl')}>
          {loading ? '…' : value == null ? '—' : value}
        </p>
      </Card>
    </Link>
  )
}

function FudoStat({
  label,
  value,
  loading,
  tone,
}: {
  label: string
  value: number | null
  loading: boolean
  tone: 'warning' | 'danger' | 'success'
}) {
  return (
    <div
      className={cn(
        'rounded-control border px-3 py-2.5',
        tone === 'warning' && 'border-orange-200 bg-orange-50/70',
        tone === 'danger' && 'border-red-200 bg-red-50/60',
        tone === 'success' && 'border-emerald-200 bg-emerald-50/60',
      )}
    >
      <p className="m-0 text-[11px] font-semibold leading-4 text-senda-muted">{label}</p>
      <p className="mb-0 mt-1 text-xl font-extrabold tabular-nums text-senda-ink">
        {loading ? '…' : value == null ? '—' : value}
      </p>
    </div>
  )
}

function QuickChip({
  href,
  icon: Icon,
  label,
}: {
  href: string
  icon: typeof FileText
  label: string
}) {
  return (
    <Link
      to={href}
      className="inline-flex items-center justify-center gap-2 rounded-control border border-senda-border bg-white px-3 py-2.5 text-sm font-semibold text-senda-ink shadow-sm transition hover:border-senda-navy/20 hover:bg-senda-subtle"
    >
      <Icon size={15} className="text-senda-orange" />
      {label}
    </Link>
  )
}

function PlatformRow({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone: 'success' | 'warning' | 'neutral'
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-control bg-senda-subtle/80 px-3 py-2.5 text-sm">
      <span className="text-senda-ink">{label}</span>
      <Badge tone={tone}>{value}</Badge>
    </div>
  )
}
