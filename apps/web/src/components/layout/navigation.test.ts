import { describe, expect, it } from 'vitest'
import {
  isNavigationGroupExpanded,
  isNavigationPathActive,
  navigationItems,
  navigationOutline,
  pageTitle,
  toggleNavigationGroup,
  type NavigationGroup,
} from './navigation'

describe('navegación GastroGest', () => {
  it('deja Facturas y Recetas como accesos principales', () => {
    expect(navigationOutline()).toEqual([
      'Resumen',
      'Inventario',
      'Facturas',
      'Recetas',
      'Ventas y consumos',
      'Historial',
      'Configuración',
    ])
    expect(navigationItems.some((entry) => entry.type === 'link' && entry.path === '/facturas')).toBe(true)
    expect(navigationItems.some((entry) => entry.type === 'link' && entry.path === '/recetas')).toBe(true)
    expect(navigationItems.some((entry) => entry.type === 'link' && entry.path === '/pendientes')).toBe(false)
    expect(navigationItems.find((entry) => entry.type === 'group' && entry.id === 'facturas')).toBeUndefined()
    expect(JSON.stringify(navigationItems)).not.toContain('Listado de facturas')
    expect(JSON.stringify(navigationItems)).not.toContain('Productos pendientes')
    expect(JSON.stringify(navigationItems)).not.toContain('Recepciones pendientes')
  })

  it('permite expandir y contraer un grupo fuera de sus rutas', () => {
    const resumen = navigationItems[0]
    if (resumen.type !== 'link') throw new Error('Resumen tiene que ser un enlace')
    const section: NavigationGroup = {
      type: 'group',
      id: 'ejemplo',
      label: 'Ejemplo',
      icon: resumen.icon,
      children: [{ label: 'Inicio', path: '/ejemplo' }],
    }
    expect(isNavigationGroupExpanded(section, '/inventario')).toBe(false)
    const open = toggleNavigationGroup({}, section, '/inventario')
    expect(isNavigationGroupExpanded(section, '/inventario', open)).toBe(true)
    const closed = toggleNavigationGroup(open, section, '/inventario')
    expect(isNavigationGroupExpanded(section, '/inventario', closed)).toBe(false)
  })

  it('marca Recetas en sus rutas y en el redirect compatible de pendientes', () => {
    expect(isNavigationPathActive('/facturas', '/facturas')).toBe(true)
    expect(isNavigationPathActive('/facturas', '/facturas/nueva')).toBe(true)
    expect(isNavigationPathActive('/facturas', '/facturas/recepciones-pendientes')).toBe(true)
    expect(isNavigationPathActive('/facturas/recepciones-pendientes', '/facturas/recepciones-pendientes')).toBe(true)
    expect(isNavigationPathActive('/recetas', '/recetas')).toBe(true)
    expect(isNavigationPathActive('/recetas', '/recetas/crear')).toBe(true)
    expect(isNavigationPathActive('/recetas', '/recetas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/editar')).toBe(true)
    expect(isNavigationPathActive('/recetas', '/pendientes')).toBe(true)
    expect(isNavigationPathActive('/pendientes', '/pendientes')).toBe(true)
  })

  it('resuelve el título de rutas internas', () => {
    expect(pageTitle('/')).toBe('Resumen')
    expect(pageTitle('/inventario')).toBe('Inventario')
    expect(pageTitle('/facturas')).toBe('Facturas')
    expect(pageTitle('/facturas/recepciones-pendientes')).toBe('Facturas')
    expect(pageTitle('/facturas/nueva')).toBe('Facturas')
    expect(pageTitle('/facturas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBe('Facturas')
    expect(pageTitle('/recetas')).toBe('Recetas')
    expect(pageTitle('/recetas/crear')).toBe('Crear receta')
    expect(pageTitle('/recetas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/editar')).toBe('Editar receta')
    expect(pageTitle('/recetas/ejemplo')).toBe('Recetas')
    expect(pageTitle('/pendientes')).toBe('Recetas')
    expect(pageTitle('/pendientes/crear')).toBe('Crear receta')
  })
})
