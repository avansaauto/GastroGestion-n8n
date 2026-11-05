import { ChevronDown, LogOut } from 'lucide-react'
import { useContext, useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { zIndex } from '@/design-system/zIndex'
import { AuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { AuthContext } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { organizationChangePath } from '@/lib/locationGate'
import { locationName, organizationName } from '@/lib/operations'
import type { Location, Organization } from '@/lib/api'
import { useWorkspaceGuardRegistry } from '@/lib/WorkspaceGuardProvider'

type WorkspaceSwitchPromptState = {
  kind: 'blocked' | 'dirty'
  title: string
  message: string
  next: { type: 'location'; id: string } | { type: 'org'; href: string } | null
}

export function WorkspaceSwitchPrompt({
  prompt,
  onCancel,
  onConfirm,
}: {
  prompt: WorkspaceSwitchPromptState | null
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!prompt) return null
  return (
    <Modal open title={prompt.title} onClose={onCancel}>
      <p className="mb-4 mt-0 text-sm text-senda-muted">{prompt.message}</p>
      {prompt.kind === 'blocked' ? (
        <Button type="button" onClick={onCancel}>Entendido</Button>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>Cancelar</Button>
          <Button type="button" onClick={onConfirm}>Descartar y cambiar</Button>
        </div>
      )}
    </Modal>
  )
}

export function HeaderLocationSwitcher({
  organization,
  location,
  locations,
  organizations,
  open = false,
  align = 'end',
  menuPlacement = 'down',
  organizationChangeHref,
  onOpenChange,
  onSelectLocation,
  onOrganizationChange,
}: {
  organization: Organization | null
  location: Location | null
  locations: Location[]
  organizations: Organization[]
  open?: boolean
  align?: 'start' | 'end'
  menuPlacement?: 'up' | 'down'
  organizationChangeHref: string
  onOpenChange?: (open: boolean) => void
  onSelectLocation: (locationId: string) => boolean
  onOrganizationChange?: (event: ReactMouseEvent<HTMLAnchorElement>, href: string) => void
}) {
  const listId = useId()
  if (!organization || !location) return null
  const canSwitchLocation = locations.length > 1
  const canSwitchOrganization = organizations.length > 1

  return (
    <div className={cn(
      'relative min-w-0',
      align === 'start' ? 'w-full text-left' : 'max-w-[46vw] text-right sm:max-w-56',
    )}>
      {canSwitchLocation ? (
        <button
          aria-controls={listId}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={`${locationName(location)}. Cambiar local`}
          className={cn(
            'flex w-full min-w-0 items-center gap-1 rounded-lg px-1 py-0.5 hover:bg-senda-subtle focus:outline-none focus:ring-2 focus:ring-senda-navy',
            align === 'start' ? 'justify-start text-left' : 'justify-end text-right',
          )}
          type="button"
          onClick={() => onOpenChange?.(!open)}
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-senda-ink">{locationName(location)}</span>
            <span className="block truncate text-xs text-senda-muted">{organizationName(organization)}</span>
          </span>
          <ChevronDown className="shrink-0 text-senda-muted" size={16} />
        </button>
      ) : (
        <div className={align === 'start' ? 'min-w-0 text-left' : undefined}>
          <p className="m-0 truncate text-sm font-semibold text-senda-ink">{locationName(location)}</p>
          <p className="m-0 truncate text-xs text-senda-muted">{organizationName(organization)}</p>
          {canSwitchOrganization && (
            <Link
              className="text-xs font-semibold text-senda-navy hover:underline"
              to={organizationChangeHref}
              onClick={(event) => onOrganizationChange?.(event, organizationChangeHref)}
            >
              Cambiar organización
            </Link>
          )}
        </div>
      )}

      {canSwitchLocation && open && (
        <div
          className={cn(
            'absolute z-50 w-64 overflow-hidden rounded-xl border border-senda-border bg-white py-1 text-left shadow-panel',
            menuPlacement === 'up' ? 'bottom-full left-0 mb-2' : 'right-0 mt-2',
          )}
          id={listId}
          role="listbox"
          aria-label="Locales autorizados"
          style={{ zIndex: zIndex.dropdown }}
        >
          {locations.map((item) => {
            const selected = item.id === location.id
            return (
              <button
                aria-selected={selected}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-senda-subtle focus:bg-senda-subtle focus:outline-none"
                key={item.id}
                role="option"
                type="button"
                onClick={() => {
                  onSelectLocation(item.id)
                  onOpenChange?.(false)
                }}
              >
                <span className={selected ? 'font-semibold' : undefined}>{locationName(item)}</span>
                {selected && <span className="text-xs text-senda-muted">Actual</span>}
              </button>
            )
          })}
          {canSwitchOrganization && (
            <Link
              className="block border-t border-senda-border px-3 py-2 text-sm font-semibold text-senda-navy hover:bg-senda-subtle"
              to={organizationChangeHref}
              onClick={(event) => onOrganizationChange?.(event, organizationChangeHref)}
            >
              Cambiar organización
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

export function HeaderWorkspace(props: {
  organization: Organization | null
  location: Location | null
  locations?: Location[]
  organizations?: Organization[]
  open?: boolean
  organizationChangeHref?: string
  onOpenChange?: (open: boolean) => void
  onSelectLocation?: (locationId: string) => boolean
  onOrganizationChange?: (event: ReactMouseEvent<HTMLAnchorElement>, href: string) => void
}) {
  return (
    <HeaderLocationSwitcher
      location={props.location}
      locations={props.locations ?? (props.location ? [props.location] : [])}
      open={props.open}
      organization={props.organization}
      organizationChangeHref={props.organizationChangeHref ?? '/entrar?cambiar=organizacion'}
      organizations={props.organizations ?? (props.organization ? [props.organization] : [])}
      onOpenChange={props.onOpenChange}
      onOrganizationChange={props.onOrganizationChange}
      onSelectLocation={props.onSelectLocation ?? (() => false)}
    />
  )
}

export function SidebarSession() {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const auth = useContext(AuthContext)
  const scope = useContext(AuthorizedScopeContext)
  const guard = useWorkspaceGuardRegistry()
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState<WorkspaceSwitchPromptState | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  function applySwitch(next: { type: 'location'; id: string } | { type: 'org'; href: string }) {
    guard.discardAll()
    if (!scope) return
    if (next.type === 'location') {
      scope.selectLocation(next.id)
      return
    }
    navigate(next.href)
  }

  function considerSwitch(next: { type: 'location'; id: string } | { type: 'org'; href: string }) {
    const report = guard.evaluate()
    if (report.kind === 'blocked') {
      setPrompt({
        kind: 'blocked',
        title: 'No se puede cambiar ahora',
        message: report.message,
        next: null,
      })
      return false
    }
    if (report.kind === 'dirty') {
      setPrompt({
        kind: 'dirty',
        title: next.type === 'org' ? '¿Cambiar de organización?' : '¿Cambiar de local?',
        message: report.message,
        next,
      })
      return false
    }
    applySwitch(next)
    return true
  }

  useEffect(() => {
    setOpen(false)
  }, [pathname, scope?.locationId])

  useEffect(() => {
    if (!open) return
    function onPointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="mt-auto border-t border-senda-border/80 px-3 py-3">
      {auth?.previewMode ? (
        <Badge className="mb-2" tone="warning">Vista previa · sin Supabase</Badge>
      ) : null}
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1" ref={rootRef}>
          {scope ? (
            <HeaderLocationSwitcher
              align="start"
              location={scope.location}
              locations={scope.locations}
              menuPlacement="up"
              open={open}
              organization={scope.organization}
              organizationChangeHref={organizationChangePath(pathname, search)}
              organizations={scope.organizations}
              onOpenChange={setOpen}
              onOrganizationChange={(event, href) => {
                event.preventDefault()
                considerSwitch({ type: 'org', href })
              }}
              onSelectLocation={(nextLocationId) => {
                if (nextLocationId === scope.locationId) return true
                return considerSwitch({ type: 'location', id: nextLocationId })
              }}
            />
          ) : null}
        </div>
        {auth ? (
          <Button aria-label="Cerrar sesión" className="px-2" variant="ghost" onClick={() => void auth.signOut()}>
            <LogOut size={17} />
          </Button>
        ) : null}
      </div>
      <WorkspaceSwitchPrompt
        prompt={prompt}
        onCancel={() => setPrompt(null)}
        onConfirm={() => {
          const next = prompt?.next
          setPrompt(null)
          if (next) applySwitch(next)
        }}
      />
    </div>
  )
}
