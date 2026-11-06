import { useEffect, useState } from 'react'
import { Cable } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { PageHeader } from '@/components/ui/PageHeader'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import {
  connectFudo,
  disconnectFudo,
  getLocationIntegrations,
  syncFudoCatalog,
  testFudoConnection,
  updateFudoCredentials,
  type FudoIntegrationView,
  type GastroProvider,
} from '@/lib/integrationsApi'
import { locationName, organizationName } from '@/lib/operations'

function formatWhen(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function statusLabel(status: FudoIntegrationView['status']) {
  if (status === 'connected') return 'Conectado'
  if (status === 'syncing') return 'Sincronizando'
  if (status === 'invalid') return 'Credenciales inválidas'
  if (status === 'error') return 'Error temporal'
  return 'Sin conexión'
}

export function IntegrationsPage() {
  const scope = useAuthorizedScopeContext()
  const locationId = scope.locationId
  const [providers, setProviders] = useState<GastroProvider[]>([])
  const [fudo, setFudo] = useState<FudoIntegrationView | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'connect' | 'test' | 'sync' | 'disconnect' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [editing, setEditing] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  useEffect(() => {
    if (!locationId) return
    let cancelled = false
    setLoading(true)
    setError('')
    getLocationIntegrations(locationId)
      .then((overview) => {
        if (cancelled) return
        setProviders(overview.providers)
        setFudo(overview.fudo)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'No se pudo cargar la integración.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [locationId])

  const connected = fudo?.status === 'connected' || fudo?.status === 'syncing' || fudo?.status === 'error'
  const showForm = !connected || editing || fudo?.status === 'invalid' || fudo?.status === 'disconnected' || !fudo

  async function refresh() {
    if (!locationId) return
    const overview = await getLocationIntegrations(locationId)
    setProviders(overview.providers)
    setFudo(overview.fudo)
  }

  async function onConnect() {
    if (!locationId) return
    setBusy('connect')
    setError('')
    setNotice('')
    try {
      const next = editing
        ? await updateFudoCredentials(locationId, { apiKey, apiSecret })
        : await connectFudo(locationId, { apiKey, apiSecret })
      setFudo(next)
      setApiKey('')
      setApiSecret('')
      setEditing(false)
      setNotice('Fudo quedó conectado. Los secretos no se guardan en este navegador.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo conectar Fudo.')
    } finally {
      setBusy(null)
    }
  }

  async function onTest() {
    if (!locationId) return
    setBusy('test')
    setError('')
    setNotice('')
    try {
      await testFudoConnection(
        locationId,
        apiKey || apiSecret ? { apiKey, apiSecret } : undefined,
      )
      setNotice('La conexión con Fudo respondió correctamente.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo probar la conexión.')
    } finally {
      setBusy(null)
    }
  }

  async function onSync() {
    if (!locationId) return
    setBusy('sync')
    setError('')
    setNotice('')
    try {
      const job = await syncFudoCatalog(locationId)
      await refresh()
      if (job.status === 'queued' || job.status === 'running') {
        setNotice('La sincronización quedó en curso. n8n tiene que ejecutar el trabajo.')
      } else if (job.status === 'succeeded') {
        setNotice(`Catálogo sincronizado: ${job.upserted} productos.`)
      } else {
        setError(job.error || 'No se pudo sincronizar el catálogo.')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo sincronizar el catálogo.')
    } finally {
      setBusy(null)
    }
  }

  async function onDisconnect() {
    if (!locationId) return
    setBusy('disconnect')
    setError('')
    setNotice('')
    try {
      const next = await disconnectFudo(locationId)
      setFudo(next)
      setConfirmDisconnect(false)
      setNotice('Fudo quedó desconectado. El catálogo y las recetas se conservan.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo desconectar Fudo.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={connected && !editing ? 'Fudo conectado' : 'Conectá tu sistema gastronómico'}
        description="Cada sucursal guarda su propia conexión. Las credenciales viajan al servidor y no quedan en el navegador."
      />

      {!locationId ? (
        <Card className="p-5">
          <p className="m-0 text-sm text-senda-muted">
            Elegí una organización y un local para configurar la integración. Si todavía no tenés acceso, pedí que te inviten. GastroGest no crea organizaciones solo.
          </p>
        </Card>
      ) : null}

      {error ? <p className="m-0 text-sm font-medium text-red-700">{error}</p> : null}
      {notice ? <p className="m-0 text-sm font-medium text-emerald-800">{notice}</p> : null}

      <div className="grid gap-4 lg:grid-cols-3">
        {(providers.length ? providers : [
          { id: 'fudo' as const, name: 'Fudo', availability: 'available' as const, summary: 'Catálogo de productos de la sucursal.' },
          { id: 'maxirest' as const, name: 'Maxirest', availability: 'soon' as const, summary: 'Próximamente.' },
          { id: 'bistrosoft' as const, name: 'Bistrosoft', availability: 'soon' as const, summary: 'Próximamente.' },
        ]).map((provider) => (
          <Card key={provider.id} className="p-5">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="m-0 text-sm font-bold">{provider.name}</h3>
              <Badge tone={provider.availability === 'available' ? 'success' : 'neutral'}>
                {provider.availability === 'available' ? 'Disponible' : 'Próximamente'}
              </Badge>
            </div>
            <p className="mb-0 text-sm leading-6 text-senda-muted">{provider.summary}</p>
          </Card>
        ))}
      </div>

      {locationId ? (
        <Card className="p-5">
          <div className="mb-4 flex items-center gap-2">
            <Cable className="text-senda-orange" size={18} />
            <h3 className="m-0 text-sm font-bold">Fudo</h3>
            {fudo ? <Badge tone={fudo.status === 'connected' ? 'success' : fudo.status === 'invalid' ? 'danger' : 'warning'}>{statusLabel(fudo.status)}</Badge> : null}
          </div>
          <p className="mt-0 text-sm leading-6 text-senda-muted">
            Se sincroniza el catálogo de productos de {scope.location ? locationName(scope.location) : 'esta sucursal'}
            {scope.organization ? ` · ${organizationName(scope.organization)}` : ''}. No se crean recetas ni se descuenta stock.
          </p>

          {loading ? <p className="text-sm text-senda-muted">Cargando estado…</p> : null}

          {fudo && connected && !editing ? (
            <div className="grid gap-3 border-t border-senda-border py-4 sm:grid-cols-2">
              <p className="m-0 text-sm"><span className="text-senda-muted">Organización: </span>{fudo.organizationName || '—'}</p>
              <p className="m-0 text-sm"><span className="text-senda-muted">Sucursal: </span>{fudo.locationName || '—'}</p>
              <p className="m-0 text-sm"><span className="text-senda-muted">Última conexión: </span>{formatWhen(fudo.lastConnectionOkAt)}</p>
              <p className="m-0 text-sm"><span className="text-senda-muted">Última sincronización: </span>{formatWhen(fudo.lastSyncAt)}</p>
              <p className="m-0 text-sm"><span className="text-senda-muted">Productos sincronizados: </span>{fudo.productCount}</p>
              <p className="m-0 text-sm"><span className="text-senda-muted">Clave: </span>{fudo.keyLast4 ? `····${fudo.keyLast4}` : '—'}</p>
              {fudo.lastSyncError ? <p className="m-0 text-sm text-red-700 sm:col-span-2">{fudo.lastSyncError}</p> : null}
            </div>
          ) : null}

          {showForm && fudo?.canManage !== false ? (
            <div className="grid max-w-xl gap-3">
              <label className="grid gap-1 text-sm font-semibold">
                API Key
                <Input
                  autoComplete="off"
                  name="fudo-api-key"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm font-semibold">
                API Secret
                <Input
                  autoComplete="off"
                  name="fudo-api-secret"
                  type={showSecret ? 'text' : 'password'}
                  value={apiSecret}
                  onChange={(event) => setApiSecret(event.target.value)}
                />
              </label>
              <button
                className="w-fit text-xs font-semibold text-senda-muted"
                type="button"
                onClick={() => setShowSecret((current) => !current)}
              >
                {showSecret ? 'Ocultar API Secret' : 'Mostrar API Secret'}
              </button>
            </div>
          ) : null}

          {fudo && fudo.canManage === false ? (
            <p className="text-sm text-senda-muted">Solo un administrador de la organización puede conectar Fudo.</p>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              {showForm ? (
                <Button disabled={busy !== null || !apiKey || !apiSecret} onClick={() => void onConnect()}>
                  {busy === 'connect' ? 'Conectando…' : editing ? 'Guardar credenciales' : 'Conectar Fudo'}
                </Button>
              ) : null}
              <Button variant="secondary" disabled={busy !== null || (!apiKey && !connected)} onClick={() => void onTest()}>
                {busy === 'test' ? 'Probando…' : 'Probar conexión'}
              </Button>
              {connected ? (
                <Button variant="secondary" disabled={busy !== null || fudo?.status === 'syncing'} onClick={() => void onSync()}>
                  {busy === 'sync' || fudo?.status === 'syncing' ? 'Sincronizando…' : 'Sincronizar ahora'}
                </Button>
              ) : null}
              {connected && !editing ? (
                <Button variant="ghost" onClick={() => { setEditing(true); setNotice(''); setError('') }}>
                  Actualizar credenciales
                </Button>
              ) : null}
              {connected && !confirmDisconnect ? (
                <Button variant="danger" onClick={() => setConfirmDisconnect(true)}>Desconectar</Button>
              ) : null}
              {confirmDisconnect ? (
                <Button variant="danger" disabled={busy !== null} onClick={() => void onDisconnect()}>
                  {busy === 'disconnect' ? 'Desconectando…' : 'Confirmar desconexión'}
                </Button>
              ) : null}
            </div>
          )}
        </Card>
      ) : null}
    </div>
  )
}
