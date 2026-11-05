import { X } from 'lucide-react'
import { NavLink, useLocation } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { SidebarSession } from './Header'
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
  onNavigate,
}: {
  pathname: string
  onNavigate?: () => void
}) {
  return (
    <nav
      aria-label="Secciones de GastroGest"
      className="mt-6 flex-1 space-y-5 overflow-y-auto overflow-x-hidden px-2"
    >
      {navigationSections.map((section) => {
        const links = navigationLinksInSection(section)
        if (links.length === 0) return null
        return (
          <div key={section.id}>
            <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[0.14em] text-senda-muted/80">
              {section.label}
            </p>
            <div className="space-y-1">
              {links.map((entry) => (
                <SidebarLink
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
  onNavigate,
}: {
  entry: NavigationLink
  pathname: string
  onNavigate?: () => void
}) {
  const Icon = entry.icon
  const active = isNavigationPathActive(entry.path, pathname)

  return (
    <NavLink
      end={entry.path === '/'}
      to={entry.path}
      onClick={onNavigate}
      className={cn(itemBase, active ? itemActive : itemIdle)}
    >
      <Icon className="shrink-0 text-senda-ink/70" size={18} strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
    </NavLink>
  )
}

function SidebarBrand({ onClose }: { onClose?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 pt-4">
      <div className="flex min-w-0 items-center gap-3">
        <img
          alt="GastroGest"
          className="h-9 w-9 shrink-0 rounded-xl object-contain"
          height={36}
          src="/Gastrogest_logo.png"
          width={36}
        />
        <div className="min-w-0">
          <p className="m-0 truncate text-[15px] font-extrabold tracking-tight text-senda-ink">GastroGest</p>
          <p className="m-0 truncate text-[11px] font-medium text-senda-muted">Ops</p>
        </div>
      </div>
      {onClose ? (
        <button
          aria-label="Cerrar menú"
          className="rounded-xl p-2 text-senda-muted hover:bg-senda-subtle lg:hidden"
          type="button"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      ) : null}
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

      <aside
        aria-label="Navegación GastroGest"
        className="hidden w-sidebar shrink-0 flex-col border-r border-senda-border bg-senda-surface text-senda-ink lg:flex"
      >
        <SidebarBrand />
        <div className="flex min-h-0 flex-1 flex-col">
          <SidebarNav pathname={pathname} />
          <SidebarSession />
        </div>
      </aside>

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-[min(18rem,88vw)] flex-col border-r border-senda-border bg-senda-surface text-senda-ink shadow-raised transition-transform lg:hidden',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <SidebarBrand onClose={onClose} />
        <div className="flex min-h-0 flex-1 flex-col">
          <SidebarNav pathname={pathname} onNavigate={onClose} />
          <SidebarSession />
        </div>
      </aside>
    </>
  )
}
