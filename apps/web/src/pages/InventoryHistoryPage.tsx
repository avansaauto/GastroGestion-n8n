import { History } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui/Card'
import { getInventoryMovements, type InventoryMovement } from '@/lib/api'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { useAuth } from '@/lib/auth'
import {
  InventoryHistoryPanel,
  inventoryScopeKey,
} from './InventoryPage'

export function InventoryHistoryPage() {
  const { previewMode } = useAuth()
  const { organizationId, locationId, error: scopeError } = useAuthorizedScopeContext()
  const scopeKey = inventoryScopeKey(organizationId, locationId)
  const [historyPage, setHistoryPage] = useState(1)
  const [history, setHistory] = useState<{
    key: string
    rows: InventoryMovement[]
    page: number
    totalPages: number
    total: number
    error: string
    loading: boolean
  }>({
    key: '',
    rows: [],
    page: 1,
    totalPages: 1,
    total: 0,
    error: '',
    loading: false,
  })

  useEffect(() => {
    setHistoryPage(1)
  }, [scopeKey])

  useEffect(() => {
    if (!organizationId || !locationId) {
      setHistory({
        key: scopeKey,
        rows: [],
        page: 1,
        totalPages: 1,
        total: 0,
        error: '',
        loading: false,
      })
      return
    }
    let cancelled = false
    setHistory((current) => ({
      ...current,
      key: scopeKey,
      error: '',
      loading: true,
    }))
    getInventoryMovements(organizationId, locationId, { page: historyPage })
      .then((result) => {
        if (cancelled) return
        setHistory({
          key: scopeKey,
          rows: Array.isArray(result.items) ? result.items : [],
          page: result.page || historyPage,
          totalPages: Math.max(1, result.totalPages || 1),
          total: result.total || 0,
          error: '',
          loading: false,
        })
        if (result.page && result.page !== historyPage) {
          setHistoryPage(result.page)
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setHistory({
            key: scopeKey,
            rows: [],
            page: historyPage,
            totalPages: 1,
            total: 0,
            error: reason instanceof Error ? reason.message : 'No se pudo leer el historial de esta sucursal.',
            loading: false,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [organizationId, locationId, scopeKey, historyPage])

  if (previewMode) {
    return (
      <Card className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
        <span className="rounded-2xl bg-senda-subtle p-4 text-senda-muted"><History size={30} /></span>
        <h2 className="mb-0 mt-5 text-xl font-bold">Supabase todavía no está configurado</h2>
        <p className="mb-0 mt-2 max-w-lg text-sm leading-6 text-senda-muted">
          Configurá las variables del frontend y la API para consultar el historial real de la sucursal.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="min-w-0">
        <h2 className="m-0 text-2xl font-extrabold tracking-tight">Historial</h2>
        <p className="mb-0 mt-2 text-sm text-senda-muted">
          Movimientos operativos del local: compras, consumos de venta, mermas, ajustes y anulaciones.
        </p>
      </div>

      {scopeError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          {scopeError}
        </div>
      ) : null}

      <InventoryHistoryPanel
        error={locationId && history.key === scopeKey ? history.error : ''}
        loading={Boolean(locationId) && (history.loading || history.key !== scopeKey)}
        page={locationId && history.key === scopeKey ? history.page : 1}
        rows={locationId && history.key === scopeKey ? history.rows : []}
        total={locationId && history.key === scopeKey ? history.total : 0}
        totalPages={locationId && history.key === scopeKey ? history.totalPages : 1}
        onPageChange={setHistoryPage}
      />
    </div>
  )
}
