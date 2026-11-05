import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { Sidebar, SidebarNav } from './Sidebar'
import { navigationItems, navigationSections } from './navigation'

function navHtml(pathname: string, collapsed = false) {
  return renderToString(
    <MemoryRouter initialEntries={[pathname]}>
      <SidebarNav
        collapsed={collapsed}
        pathname={pathname}
      />
    </MemoryRouter>,
  )
}

describe('sidebar GastroGest', () => {
  it('muestra Recetas como acceso principal y no deja Productos pendientes', () => {
    const html = navHtml('/inventario')
    expect(html).toContain('Resumen')
    expect(html).toContain('Inventario')
    expect(html).toContain('Facturas')
    expect(html).toContain('Recetas')
    expect(html).toContain('href="/recetas"')
    expect(html).toContain('Ventas y consumos')
    expect(html).toContain('Historial')
    expect(html).toContain('href="/historial"')
    expect(html).not.toContain('Integraciones')
    expect(html).toContain('Configuración')
    expect(html).toContain('href="/facturas"')
    expect(html).not.toContain('Listado de facturas')
    expect(html).not.toContain('Recepciones pendientes')
    expect(html).not.toContain('Listado de recetas')
    expect(html).not.toContain('Productos pendientes')
    expect(html).not.toContain('href="/pendientes"')
    expect(html).not.toContain('aria-expanded')
  })

  it('agrupa la navegación en secciones visuales', () => {
    const html = navHtml('/')
    expect(html).toContain('Operación')
    expect(html).toContain('Gestión')
    expect(html).toContain('Sistema')
    expect(navigationSections.map((section) => section.label)).toEqual([
      'Operación',
      'Gestión',
      'Sistema',
    ])
  })

  it('abre Facturas directo, sin submenú', () => {
    const html = navHtml('/inventario')
    expect(html).toContain('href="/facturas"')
    expect(html).toContain('>Facturas<')
    expect(html).not.toContain('Listado de facturas')
    expect(html).not.toContain('Recepciones pendientes')
    expect(html).not.toContain('href="/facturas/recepciones-pendientes"')
    expect(html).not.toContain('aria-expanded')
    expect(html).not.toContain('Productos pendientes')
  })

  it('abre Recetas sin un submenú de pendientes', () => {
    const html = navHtml('/recetas')
    expect(html).toContain('href="/recetas"')
    expect(html).toContain('Recetas')
    expect(html).not.toContain('Productos pendientes')
    expect(html).not.toContain('Listado de recetas')
    expect(html).not.toContain('href="/pendientes"')
  })

  it('marca Facturas en el detalle y no ofrece recepciones pendientes', () => {
    const html = navHtml('/facturas/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(html).toContain('href="/facturas"')
    expect(html).toContain('>Facturas<')
    expect(html).not.toContain('Listado de facturas')
    expect(html).not.toContain('Recepciones pendientes')
    expect(html).toMatch(/aria-current="page"/)
    expect(html).not.toContain('Productos pendientes')
  })

  it('permite acceder a Facturas y Recetas', () => {
    const facturas = navHtml('/facturas')
    expect(facturas).toContain('href="/facturas"')
    expect(facturas).toContain('>Facturas<')
    expect(facturas).not.toContain('Listado de facturas')
    expect(facturas).toMatch(/aria-current="page"/)
    const recetas = navHtml('/recetas')
    expect(recetas).toContain('href="/recetas"')
    expect(recetas).toMatch(/aria-current="page"/)
  })

  it('no muestra recepciones pendientes ni Productos pendientes', () => {
    expect(navHtml('/facturas/recepciones-pendientes')).not.toContain('href="/facturas/recepciones-pendientes"')
    expect(navHtml('/pendientes')).not.toContain('href="/pendientes"')
    expect(navigationItems.find((entry) => entry.type === 'group')).toBeUndefined()
    expect(navigationItems.find((entry) => entry.type === 'group' && entry.id === 'recetas')).toBeUndefined()
  })

  it('muestra la marca GastroGest con el logo oficial en el nuevo shell light', () => {
    const html = renderToString(
      <MemoryRouter initialEntries={['/inventario']}>
        <Sidebar open onClose={() => undefined} />
      </MemoryRouter>,
    )
    expect(html).toContain('GastroGest')
    expect(html).toContain('src="/Gastrogest_logo.png"')
    expect(html).toContain('aria-label="Secciones de GastroGest"')
    expect(html).not.toContain('SENDA OPS')
    expect(html).not.toContain('Etapa 1')
    expect(html).not.toContain('Interfaz base sin conexiones externas')
    expect(html).toContain('OGHAM · Barrio Chino')
    expect(html).toContain('Local activo')
    expect(html).toContain('bg-senda-surface')
    expect(html).toContain('rounded-[1.35rem]')
  })

  it('deja Facturas y Recetas como enlaces, sin submenú', () => {
    const html = navHtml('/inventario')
    expect(html).not.toContain('aria-expanded')
    expect(html).not.toContain('aria-controls')
    expect(html).not.toContain('role="group"')
    expect(html).toContain('>Facturas<')
    expect(html).toContain('>Recetas<')
    expect(html).toContain('href="/facturas"')
    expect(html).toContain('href="/recetas"')
  })

  it('en modo colapsado oculta etiquetas de sección pero conserva tooltips', () => {
    const html = navHtml('/inventario', true)
    expect(html).toContain('role="tooltip"')
    expect(html).toContain('opacity-0')
  })
})
