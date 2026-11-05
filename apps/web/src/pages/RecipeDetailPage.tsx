import { AlertCircle, ArrowLeft, Loader2, UtensilsCrossed } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { DataTable, type Column } from '@/components/ui/DataTable'
import { getRecipe, type RecipeComponentDetail, type RecipeDetail } from '@/lib/api'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useAuth } from '@/lib/auth'
import { locationName, organizationName } from '@/lib/operations'
import {
  formatRecipeCost,
  recipeComponentIssue,
  recipeComponentIssueLabel,
  recipeConsumptionLabel,
  recipeCostAmountLabel,
  recipeCostKind,
  recipeCostStatusLabel,
  recipesScopeKey,
  recipeYieldLabel,
} from './RecipesPage'

export function recipeDetailScopeKey(organizationId: string, locationId: string, recipeId: string) {
  return `${recipesScopeKey(organizationId, locationId)}::${recipeId}`
}

export function recipeDetailForScope(
  loadedKey: string,
  scopeKey: string,
  detail: RecipeDetail | null,
) {
  return loadedKey === scopeKey ? detail : null
}

function fudoLabel(detail: RecipeDetail) {
  return detail.mapping?.externalProductName?.trim() || detail.mapping?.externalProductId || 'Sin producto vinculado'
}

function formatComponentQuantity(component: RecipeComponentDetail) {
  if (!(component.quantity > 0)) return '—'
  const amount = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 }).format(component.quantity)
  return component.baseUnit ? `${amount} ${component.baseUnit}` : amount
}

const componentColumns: Column<RecipeComponentDetail>[] = [
  {
    key: 'name',
    label: 'Ingrediente',
    render: (row) => <span className="font-semibold">{row.name || '—'}</span>,
  },
  {
    key: 'quantity',
    label: 'Cantidad',
    render: (row) => formatComponentQuantity(row),
  },
  {
    key: 'unitCost',
    label: 'Costo unitario',
    render: (row) => (row.unitCost == null ? '—' : formatRecipeCost(row.unitCost)),
  },
  {
    key: 'lineCost',
    label: 'Costo del ingrediente',
    render: (row) => (row.lineCost == null ? '—' : formatRecipeCost(row.lineCost)),
  },
  {
    key: 'status',
    label: 'Estado',
    render: (row) => {
      const issue = recipeComponentIssue(row)
      const label = recipeComponentIssueLabel(issue)
      if (!label) return <Badge tone="success">Completo</Badge>
      return <Badge tone="warning">{label}</Badge>
    },
  },
]

export function RecipeDetailView({ detail }: { detail: RecipeDetail }) {
  const kind = recipeCostKind(detail)
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-3 p-5">
          <h3 className="m-0 text-base font-bold">Producto Fudo</h3>
          {detail.mapping ? (
            <>
              <p className="mb-0 font-semibold">{fudoLabel(detail)}</p>
              <p className="mb-0 text-sm text-senda-muted">{detail.mapping.externalProductId}</p>
            </>
          ) : (
            <p className="mb-0 text-sm text-senda-muted">No hay un producto de venta vinculado en este local.</p>
          )}
        </Card>
        <Card className="space-y-3 p-5">
          <h3 className="m-0 text-base font-bold">{detail.name}</h3>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={detail.consumptionMode === 'none' ? 'neutral' : 'success'}>
              {recipeConsumptionLabel(detail.consumptionMode)}
            </Badge>
            <Badge tone={kind === 'complete' ? 'success' : kind === 'pending' ? 'warning' : 'neutral'}>
              {recipeCostStatusLabel(detail)}
            </Badge>
            {detail.hasInvalidQuantities && <Badge tone="warning">Revisión necesaria</Badge>}
          </div>
          <p className="mb-0 text-sm text-senda-muted">
            Rinde {recipeYieldLabel(detail.yieldQuantity, detail.yieldUnit)}
          </p>
          <p className="mb-0 text-lg font-bold">{recipeCostAmountLabel(detail)}</p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        {detail.consumptionMode === 'none' ? (
          <div className="grid min-h-48 place-items-center px-5 text-center text-sm text-senda-muted">
            Esta receta no tiene componentes. No hay consumo configurado.
          </div>
        ) : (
          <DataTable columns={componentColumns} rowKey={(row) => row.id} rows={detail.components} />
        )}
      </Card>
    </div>
  )
}

export function RecipeDetailPage() {
  const { recipeId = '' } = useParams()
  const { previewMode } = useAuth()
  const {
    organization,
    organizationId,
    location,
    locationId,
    loading: scopeLoading,
    error: scopeError,
  } = useAuthorizedScopeContext()
  const scopeKey = recipeDetailScopeKey(organizationId, locationId, recipeId)
  const [load, setLoad] = useState<{ key: string; detail: RecipeDetail | null; error: string }>({
    key: '',
    detail: null,
    error: '',
  })
  const requestRef = useRef(0)
  const detail = recipeDetailForScope(load.key, scopeKey, load.detail)
  const error = load.key === scopeKey ? load.error : ''
  const loading = scopeLoading || (Boolean(locationId && recipeId) && load.key !== scopeKey)

  useEffect(() => {
    if (previewMode || !locationId || !recipeId) {
      requestRef.current += 1
      setLoad({
        key: recipeDetailScopeKey(organizationId, locationId, recipeId),
        detail: null,
        error: !previewMode && !locationId ? 'No hay un local activo.' : '',
      })
      return
    }
    const key = recipeDetailScopeKey(organizationId, locationId, recipeId)
    const requestId = ++requestRef.current
    getRecipe(recipeId, locationId)
      .then((next) => {
        if (requestId !== requestRef.current) return
        setLoad({ key, detail: next, error: '' })
      })
      .catch((reason: Error) => {
        if (requestId !== requestRef.current) return
        setLoad({ key, detail: null, error: reason.message })
      })
  }, [locationId, organizationId, previewMode, recipeId])

  if (previewMode) {
    return (
      <Card className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
        <span className="rounded-2xl bg-senda-subtle p-4 text-senda-muted"><UtensilsCrossed size={30} /></span>
        <h2 className="mb-0 mt-5 text-xl font-bold">Supabase todavía no está configurado</h2>
        <p className="mb-0 mt-2 max-w-lg text-sm leading-6 text-senda-muted">
          Configurá las variables del frontend y la API para consultar recetas reales.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <Link className="inline-flex items-center gap-1 text-sm font-semibold text-senda-muted hover:text-senda-ink" to="/recetas">
          <ArrowLeft size={16} /> Recetas
        </Link>
        <h2 className="mb-0 mt-3 text-2xl font-extrabold tracking-tight">
          {detail?.name || 'Receta'}
        </h2>
        {organization && location && (
          <p className="mb-0 mt-2 text-xs text-senda-muted">
            {locationName(location)} · {organizationName(organization)}
          </p>
        )}
        <p className="mb-0 mt-2 text-sm text-senda-muted">
          Consulta de composición y costos del local. Esta vista no crea ni edita recetas.
        </p>
      </div>

      {(error || scopeError) && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle size={18} /> {error || scopeError}
        </div>
      )}

      {loading ? (
        <Card className="flex min-h-[360px] items-center justify-center gap-2 text-sm text-senda-muted">
          <Loader2 className="animate-spin" size={19} /> Cargando receta…
        </Card>
      ) : !detail ? (
        <Card className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
          <AlertCircle className="text-senda-muted" size={28} />
          <h3 className="mb-0 mt-4 text-lg font-bold">Receta no disponible</h3>
          <p className="mb-0 mt-2 max-w-md text-sm leading-6 text-senda-muted">
            {error || 'No se encontró la receta en el local activo.'}
          </p>
        </Card>
      ) : (
        <RecipeDetailView detail={detail} />
      )}
    </div>
  )
}
