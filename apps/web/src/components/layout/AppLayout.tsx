import { useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Header } from './Header'
import { Sidebar } from './Sidebar'

export function AppLayout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { pathname } = useLocation()

  useEffect(() => setMenuOpen(false), [pathname])

  return (
    <div className="flex h-screen overflow-hidden bg-senda-canvas">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col pr-sidebar-gap pt-sidebar-gap lg:pb-sidebar-gap">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.35rem] border border-senda-border bg-senda-surface shadow-panel max-lg:rounded-none max-lg:border-0 max-lg:shadow-none">
          <Header onMenu={() => setMenuOpen(true)} />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="gg-page">{children}</div>
          </main>
        </div>
      </div>
    </div>
  )
}
