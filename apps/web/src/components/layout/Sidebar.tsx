import { MoreVertical, X } from 'lucide-react'
import { NavLink, useLocation } from 'react-router-dom'
import { useContext, useState } from 'react'
import { AuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { AuthContext } from '@/lib/auth'
import { locationName, organizationName } from '@/lib/operations'
import { cn } from '@/lib/utils'
import {
  isNavigationPathActive,
  navigationLinksInSection,
  navigationSections,
  type NavigationLink,
} from './navigation'

const itemBase =
  'group relative flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-semibold transition'
const itemIdle = 'text-senda-ink/80 hover:bg-senda-subtle hover:text-senda-ink'
const itemActive = 'bg-senda-subtle text-senda-ink'

export function SidebarNav({
  pathname,
  collapsed,
  onNavigate,
}: {
  pathname: string
  collapsed: boolean
  onNavigate?: () => void
}) {
  return (
    <nav
      aria-label="Secciones de GastroGest"
      className={cn('flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-2', collapsed ? 'mt-4' : 'mt-6')}
    >
      {navigationSections.map((section) => {
        const links = navigationLinksInSection(section)
        if (links.length === 0) return null
        return (
          <div key={section.id}>
            <p
              className={cn(
                'mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-senda-muted/80 transition-opacity',
                collapsed ? 'h-0 overflow-hidden opacity-0' : 'opacity-100',
              )}
            >
              {section.label}
            </p>
            <div className="space-y-1">
              {links.map((entry) => (
                <SidebarLink
                  collapsed={collapsed}
                  entry={entry}
                  key={entry.path}
                  pathname={pathname}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        )
      })}
    </nav>
  )
}

function SidebarLink({
  entry,
  pathname,
  collapsed,
  onNavigate,
}: {
  entry: NavigationLink
  pathname: string
  collapsed: boolean
  onNavigate?: () => void
}) {
  const Icon = entry.icon
  const active = isNavigationPathActive(entry.path, pathname)

  return (
    <NavLink
      end={entry.path === '/'}
      to={entry.path}
      title={collapsed ? entry.label : undefined}
      onClick={onNavigate}
      className={cn(itemBase, active ? itemActive : itemIdle, collapsed && 'justify-center px-0')}
    >
      <Icon className="shrink-0 text-senda-ink/70" size={18} strokeWidth={1.75} />
      <span
        className={cn(
          'min-w-0 flex-1 truncate transition-all',
          collapsed ? 'w-0 flex-none overflow-hidden opacity-0' : 'opacity-100',
        )}
      >
        {entry.label}
      </span>
      {collapsed ? (
        <span
          className={cn(
            'pointer-events-none absolute left-[calc(100%+0.65rem)] z-50 whitespace-nowrap rounded-lg bg-senda-navy px-2.5 py-1.5 text-xs font-semibold text-white opacity-0 shadow-raised transition',
            'group-hover:opacity-100',
          )}
          role="tooltip"
        >
          {entry.label}
        </span>
      ) : null}
    </NavLink>
  )
}

function SidebarBrand({ collapsed, onClose }: { collapsed: boolean; onClose?: () => void }) {
  return (
    <div className={cn('flex items-center gap-3 px-3 pt-4', collapsed ? 'justify-center' : 'justify-between')}>
      <div className={cn('flex min-w-0 items-center', collapsed ? 'justify-center' : 'gap-3')}>
        <img
          alt="GastroGest"
          className="h-9 w-9 shrink-0 rounded-xl object-contain"
          height={36}
          src="/Gastrogest_logo.png"
          width={36}
        />
        <div
          className={cn(
            'min-w-0 transition-all',
            collapsed ? 'w-0 overflow-hidden opacity-0' : 'opacity-100',
          )}
        >
          <p className="m-0 truncate text-[15px] font-extrabold tracking-tight text-senda-ink">GastroGest</p>
          <p className="m-0 truncate text-[11px] font-medium text-senda-muted">Ops</p>
        </div>
      </div>
      {onClose ? (
        <button
          aria-label="Cerrar menú"
          className={cn(
            'rounded-xl p-2 text-senda-muted hover:bg-senda-subtle lg:hidden',
            collapsed && 'hidden',
          )}
          type="button"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      ) : null}
    </div>
  )
}

function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  const scope = useContext(AuthorizedScopeContext)
  const auth = useContext(AuthContext)
  const locationLabel = scope?.location
    ? locationName(scope.location)
    : 'OGHAM · Barrio Chino'
  const orgLabel = scope?.organization
    ? organizationName(scope.organization)
    : 'Local activo'
  const email = auth?.user?.email?.trim() || 'operaciones@gastrogest.app'
  const initials = (locationLabel || 'GG')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'GG'

  return (
    <div className={cn('mt-auto border-t border-senda-border/80 px-2 pb-3 pt-3', collapsed && 'px-1')}>
      <div
        className={cn(
          'flex items-center gap-3 rounded-2xl px-2 py-2',
          collapsed ? 'justify-center' : 'hover:bg-senda-subtle',
        )}
      >
        <div
          aria-hidden
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-senda-navy text-xs font-bold text-white"
        >
          {initials}
        </div>
        <div
          className={cn(
            'min-w-0 flex-1 transition-all',
            collapsed ? 'w-0 overflow-hidden opacity-0' : 'opacity-100',
          )}
        >
          <p className="m-0 truncate text-sm font-bold text-senda-ink">{locationLabel}</p>
          <p className="m-0 truncate text-[11px] text-senda-muted">{orgLabel}</p>
          <p className="m-0 truncate text-[11px] text-senda-muted">{email}</p>
        </div>
        {!collapsed ? (
          <MoreVertical aria-hidden className="shrink-0 text-senda-muted" size={16} />
        ) : null}
      </div>
      {collapsed ? null : (
        <p className="mb-0 mt-1 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-senda-orange">
          Local activo
        </p>
      )}
    </div>
  )
}

export function Sidebar({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const { pathname } = useLocation()
  const [hovered, setHovered] = useState(false)
  const expanded = hovered

  return (
    <>
      {open && (
        <button
          aria-label="Cerrar menú"
          className="fixed inset-0 z-30 bg-slate-950/30 backdrop-blur-[1px] lg:hidden"
          type="button"
          onClick={onClose}
        />
      )}

      {/* Espaciador desktop: ancho colapsado fijo para no empujar el contenido al expandir */}
      <div
        aria-hidden
        className="relative hidden shrink-0 lg:block"
        style={{ width: 'calc(var(--sidebar-collapsed) + var(--sidebar-gap))' }}
      />

      {/* Desktop: rail flotante que se despliega al hover */}
      <aside
        aria-label="Navegación GastroGest"
        className={cn(
          'fixed z-40 hidden flex-col border border-senda-border bg-senda-surface text-senda-ink shadow-panel transition-[width] duration-200 ease-out lg:flex',
          'bottom-sidebar-gap left-sidebar-gap top-sidebar-gap rounded-[1.35rem]',
        )}
        style={{ width: expanded ? 'var(--sidebar-expanded)' : 'var(--sidebar-collapsed)' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <SidebarBrand collapsed={!expanded} />
        <div className="flex min-h-0 flex-1 flex-col">
          <SidebarNav collapsed={!expanded} pathname={pathname} />
          <SidebarFooter collapsed={!expanded} />
        </div>
      </aside>

      {/* Mobile: drawer completo */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[min(18rem,88vw)] flex-col border-r border-senda-border bg-senda-surface text-senda-ink shadow-raised transition-transform lg:hidden',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <SidebarBrand collapsed={false} onClose={onClose} />
        <div className="flex min-h-0 flex-1 flex-col">
          <SidebarNav collapsed={false} pathname={pathname} onNavigate={onClose} />
          <SidebarFooter collapsed={false} />
        </div>
      </aside>
    </>
  )
}
