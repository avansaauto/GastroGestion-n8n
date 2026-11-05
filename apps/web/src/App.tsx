import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { AuthorizedScopeProvider, useAuthorizedScopeContext } from '@/lib/AuthorizedScopeProvider'
import { WorkspaceGuardProvider } from '@/lib/WorkspaceGuardProvider'
import { useAuth } from '@/lib/auth'
import { locationGateRedirect, needsLocationGate } from '@/lib/locationGate'
import { LoginPage } from '@/pages/LoginPage'
import { LocationGatePage } from '@/pages/LocationGatePage'
import { InventoryPage } from '@/pages/InventoryPage'
import { InventoryHistoryPage } from '@/pages/InventoryHistoryPage'
import { SalesConsumptionsPage } from '@/pages/SalesConsumptionsPage'
import { InvoiceDetailPage } from '@/pages/invoices/InvoiceDetailPage'
import { InvoiceNewPage } from '@/pages/invoices/InvoiceNewPage'
import { InvoicesPage } from '@/pages/invoices/InvoicesPage'
import { OverviewPage } from '@/pages/OverviewPage'
import { CreateRecipePage } from '@/pages/CreateRecipePage'
import { EditRecipePage } from '@/pages/EditRecipePage'
import { RecipeDetailPage } from '@/pages/RecipeDetailPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { PendingCreateRedirect, PendingProductsRedirect, RecipesPage } from '@/pages/RecipesPage'

function ProtectedOperations() {
  const { previewMode } = useAuth()
  const scope = useAuthorizedScopeContext()
  const location = useLocation()

  if (needsLocationGate({
    previewMode,
    organizations: scope.organizations,
    locations: scope.locations,
    organizationId: scope.organizationId,
    locationId: scope.locationId,
  })) {
    return <Navigate replace to={locationGateRedirect(location.pathname, location.search)} />
  }

  return (
    <WorkspaceGuardProvider>
      <AppLayout>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/inventario" element={<InventoryPage />} />
          <Route path="/historial" element={<InventoryHistoryPage />} />
          <Route path="/integraciones" element={<Navigate replace to="/historial" />} />
          <Route path="/ventas-consumos" element={<SalesConsumptionsPage />} />
          <Route path="/recetas" element={<RecipesPage />} />
          <Route path="/recetas/crear" element={<CreateRecipePage />} />
          <Route path="/recetas/:recipeId/editar" element={<EditRecipePage />} />
          <Route path="/recetas/:recipeId" element={<RecipeDetailPage />} />
          <Route path="/pendientes" element={<PendingProductsRedirect />} />
          <Route path="/pendientes/crear" element={<PendingCreateRedirect />} />
          <Route path="/facturas" element={<InvoicesPage />} />
          <Route path="/facturas/nueva" element={<InvoiceNewPage />} />
          <Route path="/facturas/recepciones-pendientes" element={<Navigate replace to="/facturas" />} />
          <Route path="/facturas/:id" element={<InvoiceDetailPage />} />
          <Route path="/configuracion" element={<SettingsPage />} />
          <Route path="*" element={<Navigate replace to="/" />} />
        </Routes>
      </AppLayout>
    </WorkspaceGuardProvider>
  )
}

export function App() {
  const { loading, previewMode, user } = useAuth()

  if (loading) {
    return <div className="grid min-h-screen place-items-center text-sm text-senda-muted">Iniciando GastroGest…</div>
  }

  if (!previewMode && !user) return <LoginPage />

  return (
    <AuthorizedScopeProvider>
      <Routes>
        <Route path="/entrar" element={<LocationGatePage />} />
        <Route path="*" element={<ProtectedOperations />} />
      </Routes>
    </AuthorizedScopeProvider>
  )
}
