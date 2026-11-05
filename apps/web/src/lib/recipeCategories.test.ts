import { describe, expect, it } from 'vitest'
import {
  ADD_RECIPE_CATEGORY_LABEL,
  findRecipeCategoryByName,
  recipeCategoryCreateFields,
  recipeCategoryTabs,
} from './recipeCategories'

const tapeo = { id: '15151515-1515-4151-8151-151515151515', name: 'Tapeo' }

describe('contratos de categorías de receta', () => {
  it('arma pestañas desde la API y no usa una lista fija', () => {
    expect(recipeCategoryTabs([])).toEqual([{ id: 'all', label: 'Todas' }])
    expect(recipeCategoryTabs([tapeo]).map((tab) => tab.label)).toEqual(['Todas', 'Tapeo'])
    expect(JSON.stringify(recipeCategoryTabs([]))).not.toMatch(/Entradas|Platos principales|Postres/)
  })

  it('reutiliza el id si el nombre nuevo solo cambia mayúsculas o espacios', () => {
    expect(findRecipeCategoryByName([tapeo], '  TAPEO  ')).toEqual(tapeo)
    expect(recipeCategoryCreateFields({ kind: 'new', name: 'tapeo' }, [tapeo])).toEqual({
      categoryId: tapeo.id,
    })
  })

  it('no persiste una categoría nueva hasta el POST de la receta', () => {
    expect(recipeCategoryCreateFields({ kind: 'new', name: '  Brunch  ' })).toEqual({
      categoryName: 'Brunch',
    })
    expect(recipeCategoryCreateFields({ kind: 'existing', categoryId: tapeo.id })).toEqual({
      categoryId: tapeo.id,
    })
    expect(ADD_RECIPE_CATEGORY_LABEL).toBe('+ Agregar categoría')
  })
})
