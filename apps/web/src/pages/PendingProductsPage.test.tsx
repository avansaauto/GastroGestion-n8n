import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/lib/auth'
import { AuthorizedScopeProvider } from '@/lib/AuthorizedScopeProvider'
import { createPendingRecipePath, pendingProductIdentity } from '@/lib/pendingRecipe'
import {
  PendingProductsPage,
  pendingProductsForScope,
  pendingProductsScopeKey,
} from './PendingProductsPage'

describe('Productos pendientes', () => {
  it('usa el local global y no muestra selectores independientes', () => {
    const html = renderToString(
      <MemoryRouter>
        <AuthProvider>
          <AuthorizedScopeProvider>
            <PendingProductsPage />
          </AuthorizedScopeProvider>
        </AuthProvider>
      </MemoryRouter>,
    )
    expect(html).toContain('Productos pendientes')
    expect(html).not.toContain('>Organización<')
    expect(html).not.toContain('>Local<')
  })

  it('abre crear receta con la identidad Fudo, no con el nombre', () => {
    const product = {
      id: '1',
      location_id: 'loc-a',
      status: 'pending',
      product_name: 'Pinta IPA',
      source: 'fudo',
      external_product_id: 'fudo-pinta-ipa',
    }
    expect(pendingProductIdentity(product)).toEqual({
      source: 'fudo',
      externalProductId: 'fudo-pinta-ipa',
    })
    expect(createPendingRecipePath(pendingProductIdentity(product)!)).toBe(
      '/pendientes/crear?source=fudo&externalProductId=fudo-pinta-ipa',
    )
    expect(createPendingRecipePath({
      ...pendingProductIdentity(product)!,
      intent: 'link',
    })).toContain('intent=link')
  })

  it('no deja visibles productos de un local anterior', () => {
    expect(pendingProductsScopeKey('org-1', 'loc-a')).not.toBe(pendingProductsScopeKey('org-1', 'loc-b'))
    expect(pendingProductsForScope(
      'org-1::loc-a',
      'org-1::loc-b',
      [{ id: '1', location_id: 'loc-a', status: 'pending', product_name: 'Pilsen Casa' }],
    )).toEqual([])
    expect(pendingProductsForScope(
      'org-1::loc-b',
      'org-1::loc-b',
      [{ id: '2', location_id: 'loc-b', status: 'pending', product_name: 'Harina Norte' }],
    ).map((row) => row.product_name)).toEqual(['Harina Norte'])
  })
})
