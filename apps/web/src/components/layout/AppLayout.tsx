import { Menu } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'

export function AppLayout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { pathname } = useLocation()

  useEffect(() => setMenuOpen(false), [pathname])

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-senda-surface">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center px-3 pt-3 lg:hidden">
            <button
              aria-label="Abrir menú"
              className="rounded-control p-2 text-senda-muted hover:bg-senda-subtle"
              type="button"
              onClick={() => setMenuOpen(true)}
            >
              <Menu size={20} />
            </button>
          </div>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="gg-page">{children}</div>
          </main>
        </div>
      </div>
    </div>
  )
}
