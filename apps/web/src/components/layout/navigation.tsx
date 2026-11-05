import {
  Boxes,
  ChartNoAxesCombined,
  CircleGauge,
  FileText,
  History,
  Settings,
  UtensilsCrossed,
  type LucideIcon,
} from 'lucide-react'

export type NavigationLink = {
  type: 'link'
  label: string
  path: string
  icon: LucideIcon
}

export type NavigationChild = {
  label: string
  path: string
}

export type NavigationGroup = {
  type: 'group'
  id: string
  label: string
  icon: LucideIcon
  children: NavigationChild[]
}

export type NavigationEntry = NavigationLink | NavigationGroup

export const navigationItems: NavigationEntry[] = [
  { type: 'link', label: 'Resumen', path: '/', icon: CircleGauge },
  { type: 'link', label: 'Inventario', path: '/inventario', icon: Boxes },
  { type: 'link', label: 'Facturas', path: '/facturas', icon: FileText },
  { type: 'link', label: 'Recetas', path: '/recetas', icon: UtensilsCrossed },
  { type: 'link', label: 'Ventas y consumos', path: '/ventas-consumos', icon: ChartNoAxesCombined },
  { type: 'link', label: 'Historial', path: '/historial', icon: History },
  { type: 'link', label: 'Configuración', path: '/configuracion', icon: Settings },
]

export type NavigationSection = {
  id: string
  label: string
  paths: string[]
}

/** Secciones visuales de la sidebar (no cambian rutas ni permisos). */
export const navigationSections: NavigationSection[] = [
  { id: 'operacion', label: 'Operación', paths: ['/', '/inventario', '/ventas-consumos'] },
  { id: 'gestion', label: 'Gestión', paths: ['/facturas', '/recetas'] },
  { id: 'sistema', label: 'Sistema', paths: ['/historial', '/configuracion'] },
]

export function navigationLinksInSection(section: NavigationSection): NavigationLink[] {
  return section.paths
    .map((path) => navigationItems.find((entry): entry is NavigationLink => (
      entry.type === 'link' && entry.path === path
    )))
    .filter((entry): entry is NavigationLink => Boolean(entry))
}

export function normalizePath(pathname: string) {
  if (pathname === '/') return '/'
  return pathname.replace(/\/+$/, '') || '/'
}

export function isNavigationPathActive(path: string, pathname: string) {
  const current = normalizePath(pathname)
  const target = normalizePath(path)
  if (current === target) return true
  if (target === '/facturas') return current.startsWith('/facturas/')
  if (target === '/recetas') {
    return current.startsWith('/recetas/')
      || current === '/pendientes'
      || current.startsWith('/pendientes/')
  }
  return false
}

export function navigationGroupContains(group: NavigationGroup, pathname: string) {
  const current = normalizePath(pathname)
  if (group.id === 'recetas') {
    return current === '/recetas' || current.startsWith('/recetas/')
  }
  return group.children.some((child) => (
    current === normalizePath(child.path) || current.startsWith(`${normalizePath(child.path)}/`)
  ))
}

export function isNavigationGroupExpanded(
  group: NavigationGroup,
  pathname: string,
  userExpanded: Record<string, boolean> = {},
) {
  if (navigationGroupContains(group, pathname)) return true
  return userExpanded[group.id] === true
}

export function toggleNavigationGroup(
  userExpanded: Record<string, boolean>,
  group: NavigationGroup,
  pathname: string,
) {
  const open = isNavigationGroupExpanded(group, pathname, userExpanded)
  if (navigationGroupContains(group, pathname) && open) {
    return { ...userExpanded, [group.id]: true }
  }
  return { ...userExpanded, [group.id]: !open }
}

export function activeNavigationLabel(pathname: string) {
  const current = normalizePath(pathname)
  if (current === '/pendientes/crear' || current === '/recetas/crear') return 'Crear receta'
  if (/^\/recetas\/[^/]+\/editar$/.test(current)) return 'Editar receta'
  if (current === '/pendientes' || current.startsWith('/pendientes/')) return 'Recetas'
  for (const entry of navigationItems) {
    if (entry.type === 'link' && isNavigationPathActive(entry.path, pathname)) {
      return entry.label
    }
    if (entry.type === 'group') {
      const child = entry.children.find((item) => isNavigationPathActive(item.path, pathname))
      if (child) return child.label
    }
  }
  return null
}

export function pageTitle(pathname: string) {
  const current = activeNavigationLabel(pathname)
  if (current) return current
  const group = navigationItems.find((entry): entry is NavigationGroup => (
    entry.type === 'group' && navigationGroupContains(entry, pathname)
  ))
  return group?.label ?? 'GastroGest'
}

export function navigationOutline() {
  return navigationItems.map((entry) => {
    if (entry.type === 'link') return entry.label
    return { label: entry.label, children: entry.children.map((child) => child.label) }
  })
}
