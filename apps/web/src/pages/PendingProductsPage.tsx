import { AlertCircle, ClipboardList, Loader2, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { getPendingProducts, type PendingProduct } from '@/lib/api'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { locationName, organizationName } from '@/lib/operations'
import { useAuth } from '@/lib/auth'
import { createPendingRecipePath, pendingProductIdentity } from '@/lib/pendingRecipe'

type Status = 'pending' | 'resolved'

export function pendingProductsScopeKey(organizationId: string, locationId: string) {
  return `${organizationId}::${locationId}`
}

export function pendingProductsForScope(
  loadedKey: string,
  scopeKey: string,
  products: PendingProduct[],
) {
  return loadedKey === scopeKey ? products : []
}

function text(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number') return String(value)
  }
  return '—'
}

function formatDate(value: unknown) {
  if (typeof value !== 'string' || !value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function productName(product: PendingProduct) {
  return text(product, ['product_name', 'external_product_name', 'fudo_product_name', 'name'])
}

export function PendingProductsPage() {
  const { previewMode } = useAuth()
  const {
    organization,
    organizationId,
    location,
    locationId,
    loading: scopeLoading,
    error: scopeError,
  } = useAuthorizedScopeContext()
  const scopeKey = pendingProductsScopeKey(organizationId, locationId)
  const [load, setLoad] = useState<{ key: string; products: PendingProduct[]; error: string }>({
    key: '',
    products: [],
    error: '',
  })
  const [status, setStatus] = useState<Status>('pending')
  const [search, setSearch] = useState('')
  const requestRef = useRef(0)
  const products = pendingProductsForScope(load.key, scopeKey, load.products)
  const error = load.key === scopeKey ? load.error : ''
  const loading = scopeLoading || (Boolean(locationId) && load.key !== scopeKey)

  useEffect(() => {
    if (previewMode || !locationId) {
      requestRef.current += 1
      setLoad({ key: pendingProductsScopeKey(organizationId, locationId), products: [], error: '' })
      return
    }
    const key = pendingProductsScopeKey(organizationId, locationId)
    const requestId = ++requestRef.current
    getPendingProducts(locationId, status)
      .then((next) => {
        if (requestId !== requestRef.current) return
        setLoad({ key, products: next, error: '' })
      })
      .catch((reason: Error) => {
        if (requestId !== requestRef.current) return
        setLoad({ key, products: [], error: reason.message })
      })
  }, [locationId, organizationId, previewMode, status])

  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase('es')
    if (!term) return products
    return products.filter((product) => productName(product).toLocaleLowerCase('es').includes(term))
  }, [products, search])

  if (previewMode) {
    return (
      <EmptyState
        title="Supabase todavía no está configurado"
        description="Configurá las variables del frontend y la API para consultar productos reales. El modo vista previa nunca solicita información operativa."
      />
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="m-0 text-2xl font-extrabold tracking-tight">Productos pendientes</h2>
        <p className="mb-0 mt-2 text-sm text-senda-muted">Productos detectados en Fudo que necesitan revisión.</p>
        {organization && location && (
          <p className="mb-0 mt-2 text-xs text-senda-muted">
            {locationName(location)} · {organizationName(organization)}
          </p>
        )}
      </div>

      <Card className="p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Select value={status} onChange={(value) => setStatus(value as Status)} label="Estado">
            <option value="pending">Pendiente</option>
            <option value="resolved">Resuelto</option>
          </Select>
          <label className="space-y-1.5 text-xs font-semibold text-senda-muted">
            Buscar por nombre
            <span className="relative block">
              <Search className="absolute left-3 top-3 text-slate-400" size={17} />
              <Input className="pl-9" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar producto…" />
            </span>
          </label>
        </div>
      </Card>

      {(error || scopeError) && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <AlertCircle size={18} /> {error || scopeError}
        </div>
      )}

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-senda-muted">
            <Loader2 className="animate-spin" size={19} /> Cargando…
          </div>
        ) : !locationId ? (
          <EmptyContent message="No hay un local activo." />
        ) : filtered.length === 0 ? (
          <EmptyContent message={search ? 'No hay resultados para la búsqueda.' : 'No hay productos para el estado seleccionado.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead className="border-b border-senda-border bg-senda-subtle text-xs uppercase tracking-wide text-senda-muted">
                <tr>
                  {['Producto', 'ID externo Fudo', 'Origen', 'Estado', 'Primera detección', 'Última detección', 'Acciones'].map((label) => (
                    <th className="px-5 py-3 font-semibold" key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((product) => {
                  const identity = pendingProductIdentity(product)
                  return (
                    <tr className="border-b border-senda-border last:border-0" key={product.id}>
                      <td className="px-5 py-4 font-semibold">{productName(product)}</td>
                      <td className="px-5 py-4 text-senda-muted">{text(product, ['external_product_id', 'fudo_product_id', 'external_id'])}</td>
                      <td className="px-5 py-4">{text(product, ['source', 'origin'])}</td>
                      <td className="px-5 py-4"><Badge tone={product.status === 'resolved' ? 'success' : 'warning'}>{product.status || 'pending'}</Badge></td>
                      <td className="px-5 py-4 text-senda-muted">{formatDate(product.first_seen_at)}</td>
                      <td className="px-5 py-4 text-senda-muted">{formatDate(product.last_seen_at)}</td>
                      <td className="px-5 py-4">
                        {product.status !== 'resolved' && identity ? (
                          <div className="flex flex-col gap-2">
                            <Link
                              className="text-sm font-semibold text-senda-navy hover:underline"
                              to={createPendingRecipePath(identity)}
                            >
                              Crear receta
                            </Link>
                            <Link
                              className="text-sm font-semibold text-senda-navy hover:underline"
                              to={createPendingRecipePath({ ...identity, intent: 'link' })}
                            >
                              Vincular receta existente
                            </Link>
                          </div>
                        ) : (
                          <span className="text-senda-muted">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function EmptyContent({ message }: { message: string }) {
  return <div className="grid min-h-64 place-items-center px-5 text-center text-sm text-senda-muted">{message}</div>
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <Card className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
      <span className="rounded-2xl bg-senda-subtle p-4 text-senda-muted"><ClipboardList size={30} /></span>
      <h2 className="mb-0 mt-5 text-xl font-bold">{title}</h2>
      <p className="mb-0 mt-2 max-w-lg text-sm leading-6 text-senda-muted">{description}</p>
    </Card>
  )
}
