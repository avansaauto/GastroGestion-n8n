import { Cable, Clock3, MapPin, Shield, Building2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { locationName, organizationName } from '@/lib/operations'

function SettingRow({
  label,
  value,
  hint,
  badge,
}: {
  label: string
  value: string
  hint?: string
  badge?: { tone: 'success' | 'neutral' | 'warning' | 'info'; label: string }
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-senda-border py-4 last:border-0">
      <div className="min-w-0">
        <p className="m-0 text-sm font-semibold text-senda-ink">{label}</p>
        {hint ? <p className="mb-0 mt-1 text-xs leading-5 text-senda-muted">{hint}</p> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-right">
        <span className="text-sm font-medium text-senda-ink">{value}</span>
        {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : null}
      </div>
    </div>
  )
}

export function SettingsPage() {
  const { organization, location, organizations, locations } = useAuthorizedScopeContext()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Configuración"
        description="Espacio de trabajo activo, integraciones y automatizaciones de GastroGest."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <div className="mb-1 flex items-center gap-2">
            <Building2 className="text-senda-orange" size={18} />
            <h3 className="m-0 text-sm font-bold">Organización</h3>
          </div>
          <SettingRow
            label="Organización activa"
            value={organization ? organizationName(organization) : '—'}
            hint={organizations.length > 1 ? `${organizations.length} organizaciones disponibles` : 'Única organización autorizada'}
          />
          <SettingRow
            label="Sucursal activa"
            value={location ? locationName(location) : '—'}
            hint={locations.length > 1 ? `${locations.length} locales en esta organización` : undefined}
            badge={location ? { tone: 'success', label: 'En uso' } : undefined}
          />
          <p className="mb-0 mt-3 text-xs text-senda-muted">
            Para cambiar de local u organización usá el selector del encabezado.
          </p>
        </Card>

        <Card className="p-5">
          <div className="mb-1 flex items-center gap-2">
            <MapPin className="text-senda-orange" size={18} />
            <h3 className="m-0 text-sm font-bold">Operación del local</h3>
          </div>
          <SettingRow
            label="Inventario y recetas"
            value="Activos"
            badge={{ tone: 'success', label: 'Listo' }}
            hint="Stock, costos, recetas y vinculación Fudo."
          />
          <SettingRow
            label="Facturas"
            value="Disponible"
            badge={{ tone: 'info', label: 'Módulo' }}
            hint="Carga, mapeo y recepción de comprobantes."
          />
          <div className="pt-3">
            <Link className="text-sm font-semibold text-senda-navy hover:underline" to="/inventario">
              Ir a Inventario
            </Link>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-1 flex items-center gap-2">
            <Cable className="text-senda-orange" size={18} />
            <h3 className="m-0 text-sm font-bold">Integraciones</h3>
          </div>
          <SettingRow
            label="Fudo"
            value="Por sucursal"
            badge={{ tone: 'info', label: 'Configurar' }}
            hint="La conexión se administra en Integraciones. No queda marcada como activa para todos los locales."
          />
          <div className="pt-3">
            <Link className="text-sm font-semibold text-senda-navy hover:underline" to="/integraciones">
              Abrir integraciones
            </Link>
          </div>
          <SettingRow
            label="Supabase"
            value="SENDA"
            badge={{ tone: 'success', label: 'En uso' }}
            hint="Datos operativos, autenticación y RPCs."
          />
          <SettingRow
            label="n8n"
            value="Automatizaciones"
            badge={{ tone: 'info', label: 'Piloto' }}
            hint="Sync Fudo productiva pendiente de activación programada."
          />
        </Card>

        <Card className="p-5">
          <div className="mb-1 flex items-center gap-2">
            <Clock3 className="text-senda-orange" size={18} />
            <h3 className="m-0 text-sm font-bold">Automatizaciones</h3>
          </div>
          <SettingRow
            label="Sync nocturna Fudo"
            value="Pendiente"
            badge={{ tone: 'warning', label: 'Próximo' }}
            hint="Objetivo: ventas cerradas ~04:00, con idempotencia y sin históricas."
          />
          <SettingRow
            label="Consumos de venta"
            value="Manual / evento"
            badge={{ tone: 'info', label: 'Activo' }}
            hint="Los eventos reales ya descuentan inventario cuando se registran."
          />
        </Card>

        <Card className="p-5 lg:col-span-2">
          <div className="mb-1 flex items-center gap-2">
            <Shield className="text-senda-orange" size={18} />
            <h3 className="m-0 text-sm font-bold">Usuarios y permisos</h3>
          </div>
          <SettingRow
            label="Acceso actual"
            value="Miembro autorizado"
            hint="La gestión de roles y convites se habilitará en una próxima etapa."
            badge={{ tone: 'neutral', label: 'Placeholder' }}
          />
        </Card>
      </div>
    </div>
  )
}
