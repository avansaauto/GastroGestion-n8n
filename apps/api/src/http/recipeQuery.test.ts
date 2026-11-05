import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { recipeQuery } from './recipeQuery.js'
import { RecipeQueryError } from './recipeQueryError.js'

const ORG = '11111111-1111-4111-8111-111111111111'
const OTHER_ORG = '99999999-9999-4999-8999-999999999999'
const LOC = '22222222-2222-4222-8222-222222222222'
const OTHER_LOC = '33333333-3333-4333-8333-333333333333'
const RECIPE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NESTED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PRODUCT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_PRODUCT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const COMPONENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const COMPONENT_B = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const MAPPING = '12121212-1212-4121-8121-121212121212'
const MAPPING_B = '13131313-1313-4131-8131-131313131313'
const LI = '14141414-1414-4141-8141-141414141414'

function filterable(
  rows: Record<string, unknown>[],
  error: { message?: string } | null = null,
) {
  let filtered = [...rows]
  const builder: Record<string, unknown> = {}
  const self = () => builder
  builder.select = self
  builder.eq = (column: string, value: string) => {
    filtered = filtered.filter((row) => String(row[column] ?? '') === value)
    return builder
  }
  builder.in = (column: string, values: string[]) => {
    const allowed = new Set(values)
    filtered = filtered.filter((row) => allowed.has(String(row[column] ?? '')))
    return builder
  }
  builder.maybeSingle = async () => ({
    data: error ? null : filtered[0] ?? null,
    error,
  })
  builder.then = (resolve: (value: { data: unknown; error: unknown }) => void) => {
    resolve({ data: error ? null : filtered, error })
  }
  return builder
}

function client(options: {
  organizations?: Record<string, unknown>[]
  organizationError?: { message?: string } | null
  locations?: Record<string, unknown>[]
  locationError?: { message?: string } | null
  mappings?: Record<string, unknown>[]
  recipes?: Record<string, unknown>[]
  components?: Record<string, unknown>[]
  pending?: Record<string, unknown>[]
  products?: Record<string, unknown>[]
  locationInventory?: Record<string, unknown>[]
  valuations?: Record<string, unknown>[]
  valuationsError?: { message?: string } | null
  categories?: Record<string, unknown>[]
  categoriesError?: { message?: string; code?: string } | null
} = {}) {
  const tables: string[] = []
  const from = vi.fn((table: string) => {
    tables.push(table)
    if (table === 'inventory_movements') {
      throw new Error('inventory_movements no debe consultarse')
    }
    if (table === 'organizations') {
      return filterable(
        options.organizations ?? [{ id: ORG }],
        options.organizationError ?? null,
      )
    }
    if (table === 'locations') {
      return filterable(
        options.locations ?? [{ id: LOC, organization_id: ORG }],
        options.locationError ?? null,
      )
    }
    if (table === 'sales_product_mappings') {
      return filterable(options.mappings ?? [])
    }
    if (table === 'recipes') {
      return filterable(options.recipes ?? [])
    }
    if (table === 'recipe_components') {
      return filterable(options.components ?? [])
    }
    if (table === 'pending_product_mappings') {
      return filterable(options.pending ?? [])
    }
    if (table === 'inventory_products') {
      return filterable(options.products ?? [])
    }
    if (table === 'location_inventory') {
      return filterable(options.locationInventory ?? [])
    }
    if (table === 'inventory_valuations') {
      return filterable(options.valuations ?? [], options.valuationsError ?? null)
    }
    if (table === 'recipe_categories') {
      return filterable(options.categories ?? [], options.categoriesError ?? null)
    }
    throw new Error(`tabla inesperada: ${table}`)
  })
  return { from, tables, client: { from } as unknown as SupabaseClient }
}

const recipeRow = {
  id: RECIPE,
  organization_id: ORG,
  name: 'IPA de barril',
  recipe_type: 'sale_product',
  active: true,
  yield_quantity: 1,
  yield_unit: 'unit',
}

const mappingRow = {
  id: MAPPING,
  location_id: LOC,
  source: 'fudo',
  external_product_id: 'fudo-ipa',
  external_product_name: 'IPA',
  recipe_id: RECIPE,
  active: true,
}

describe('listLocationRecipes', () => {
  it('no consulta recetas si el local no es visible por JWT', async () => {
    const db = client({ locations: [] })
    await expect(recipeQuery.listLocationRecipes(db.client, LOC)).rejects.toMatchObject({
      name: 'RecipeQueryError',
      message: 'Local no disponible.',
      status: 404,
      code: 'NOT_FOUND',
    })
    expect(db.tables).toEqual(['locations'])
  })

  it('lista un renglón por producto de venta vinculado y calcula el costo del local', async () => {
    const db = client({
      mappings: [
        mappingRow,
        {
          ...mappingRow,
          id: MAPPING_B,
          external_product_id: 'fudo-ipa-pinta',
          external_product_name: 'IPA pinta',
        },
        { ...mappingRow, id: 'inactive', active: false, external_product_id: 'fudo-old' },
        { ...mappingRow, id: 'other-loc', location_id: OTHER_LOC, external_product_id: 'fudo-other' },
      ],
      recipes: [recipeRow, { ...recipeRow, id: NESTED, organization_id: OTHER_ORG, name: 'Ajena' }],
      components: [{
        id: COMPONENT,
        recipe_id: RECIPE,
        inventory_product_id: PRODUCT,
        component_recipe_id: null,
        quantity: 330,
      }],
      products: [{ id: PRODUCT, organization_id: ORG, name: 'Lúpulo', base_unit: 'g' }],
      locationInventory: [{
        id: LI,
        location_id: LOC,
        inventory_product_id: PRODUCT,
      }],
      valuations: [{ location_inventory_id: LI, average_unit_cost: 2 }],
      pending: [{
        location_id: LOC,
        source: 'fudo',
        external_product_id: 'fudo-ipa',
        status: 'resolved',
      }],
    })

    const items = await recipeQuery.listLocationRecipes(db.client, LOC)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      id: RECIPE,
      name: 'IPA de barril',
      recipeType: 'sale_product',
      componentCount: 1,
      consumptionMode: 'direct',
      costPerYield: 660,
      costIncomplete: false,
      hasInvalidQuantities: false,
      pendingStatus: 'resolved',
      mapping: {
        source: 'fudo',
        externalProductId: 'fudo-ipa',
        externalProductName: 'IPA',
        active: true,
      },
    })
    expect(items[1].mapping.externalProductId).toBe('fudo-ipa-pinta')
    expect(items[1].pendingStatus).toBeNull()
    expect(JSON.stringify(items)).not.toMatch(/salePrice|inventory_movements/)
    expect(db.tables).not.toContain('inventory_movements')
  })

  it('no inventa costo ni lo reemplaza por cero cuando falta valuación', async () => {
    const db = client({
      mappings: [mappingRow],
      recipes: [recipeRow],
      components: [{
        id: COMPONENT,
        recipe_id: RECIPE,
        inventory_product_id: PRODUCT,
        component_recipe_id: null,
        quantity: 100,
      }],
      locationInventory: [],
      valuations: [],
    })
    const [item] = await recipeQuery.listLocationRecipes(db.client, LOC)
    expect(item.costPerYield).toBeNull()
    expect(item.costIncomplete).toBe(true)
    expect(item.costPerYield).not.toBe(0)
  })

  it('sin componentes el costo estimado es 0 y está completo', async () => {
    const db = client({
      mappings: [mappingRow],
      recipes: [recipeRow],
      components: [],
    })
    const [item] = await recipeQuery.listLocationRecipes(db.client, LOC)
    expect(item).toMatchObject({
      componentCount: 0,
      consumptionMode: 'none',
      costPerYield: 0,
      costIncomplete: false,
      hasInvalidQuantities: false,
    })
    expect(db.tables).not.toContain('location_inventory')
  })

  it('no trata un BOM con cantidades inválidas como receta sin consumo', async () => {
    const db = client({
      mappings: [mappingRow],
      recipes: [recipeRow],
      components: [
        {
          id: COMPONENT,
          recipe_id: RECIPE,
          inventory_product_id: PRODUCT,
          component_recipe_id: null,
          quantity: 0,
        },
        {
          id: COMPONENT_B,
          recipe_id: RECIPE,
          inventory_product_id: PRODUCT,
          component_recipe_id: null,
          quantity: null,
        },
      ],
      locationInventory: [{ id: LI, location_id: LOC, inventory_product_id: PRODUCT }],
      valuations: [{ location_inventory_id: LI, average_unit_cost: 2 }],
    })
    const [item] = await recipeQuery.listLocationRecipes(db.client, LOC)
    expect(item.componentCount).toBe(2)
    expect(item.consumptionMode).toBe('compound')
    expect(item.consumptionMode).not.toBe('none')
    expect(item.costIncomplete).toBe(true)
    expect(item.costPerYield).toBeNull()
    expect(item.costPerYield).not.toBe(0)
    expect(item.hasInvalidQuantities).toBe(true)
  })

  it('omite recetas de otra organización aunque el mapping sea visible', async () => {
    const db = client({
      mappings: [mappingRow],
      recipes: [{ ...recipeRow, organization_id: OTHER_ORG }],
      components: [{
        id: COMPONENT,
        recipe_id: RECIPE,
        inventory_product_id: PRODUCT,
        quantity: 1,
      }],
    })
    await expect(recipeQuery.listLocationRecipes(db.client, LOC)).resolves.toEqual([])
    expect(db.tables).not.toContain('location_inventory')
  })
})

describe('getRecipeDetail', () => {
  it('exige un local visible y no confía en una organización del cliente', async () => {
    const db = client({ locations: [] })
    await expect(recipeQuery.getRecipeDetail(db.client, RECIPE, LOC)).rejects.toBeInstanceOf(RecipeQueryError)
    expect(db.tables).toEqual(['locations'])
  })

  it('no expone una receta de otra organización', async () => {
    const db = client({
      recipes: [{ ...recipeRow, organization_id: OTHER_ORG }],
    })
    await expect(recipeQuery.getRecipeDetail(db.client, RECIPE, LOC)).rejects.toMatchObject({
      message: 'Receta no disponible.',
      status: 404,
    })
  })

  it('devuelve componentes, unidades y marca costos faltantes o anidados', async () => {
    const db = client({
      mappings: [
        mappingRow,
        { ...mappingRow, id: MAPPING_B, location_id: OTHER_LOC, external_product_id: 'fudo-bar' },
      ],
      recipes: [
        recipeRow,
        {
          id: NESTED,
          organization_id: ORG,
          name: 'Jarabe',
          recipe_type: 'preparation',
          active: true,
          yield_quantity: 1,
          yield_unit: 'ml',
        },
      ],
      components: [
        {
          id: COMPONENT,
          recipe_id: RECIPE,
          inventory_product_id: PRODUCT,
          component_recipe_id: null,
          quantity: 10,
        },
        {
          id: COMPONENT_B,
          recipe_id: RECIPE,
          inventory_product_id: null,
          component_recipe_id: NESTED,
          quantity: 5,
        },
        {
          id: 'other-recipe',
          recipe_id: NESTED,
          inventory_product_id: OTHER_PRODUCT,
          quantity: 99,
        },
      ],
      products: [{ id: PRODUCT, organization_id: ORG, name: 'Malta', base_unit: 'g' }],
      locationInventory: [{ id: LI, location_id: LOC, inventory_product_id: PRODUCT }],
      valuations: [{ location_inventory_id: LI, average_unit_cost: 1.5 }],
    })

    const detail = await recipeQuery.getRecipeDetail(db.client, RECIPE, LOC)
    expect(detail.organizationId).toBe(ORG)
    expect(detail.locationId).toBe(LOC)
    expect(detail.consumptionMode).toBe('compound')
    expect(detail.componentCount).toBe(2)
    expect(detail.sharedLocationCount).toBe(2)
    expect(detail.mapping?.externalProductId).toBe('fudo-ipa')
    expect(detail.costIncomplete).toBe(true)
    expect(detail.costPerYield).toBeNull()
    expect(detail.hasInvalidQuantities).toBe(false)
    expect(detail.components).toEqual([
      {
        id: COMPONENT,
        inventoryProductId: PRODUCT,
        componentRecipeId: null,
        name: 'Malta',
        baseUnit: 'g',
        quantity: 10,
        unitCost: 1.5,
        lineCost: 15,
        costMissing: false,
      },
      {
        id: COMPONENT_B,
        inventoryProductId: null,
        componentRecipeId: NESTED,
        name: 'Jarabe',
        baseUnit: null,
        quantity: 5,
        unitCost: null,
        lineCost: null,
        costMissing: true,
      },
    ])
    expect(detail.category).toBeNull()
    expect(JSON.stringify(detail)).not.toMatch(/salePrice/)
    expect(db.tables).not.toContain('inventory_movements')
  })

  it('incluye la categoría para precargar la edición y no escribe mappings', async () => {
    const categoryId = '15151515-1515-4151-8151-151515151515'
    const db = client({
      recipes: [{ ...recipeRow, category_id: categoryId }],
      components: [{
        id: COMPONENT,
        recipe_id: RECIPE,
        inventory_product_id: PRODUCT,
        component_recipe_id: null,
        quantity: 10,
      }],
      products: [{ id: PRODUCT, organization_id: ORG, name: 'Malta', base_unit: 'g' }],
      categories: [{ id: categoryId, organization_id: ORG, name: 'Tapeo' }],
    })
    const detail = await recipeQuery.getRecipeDetail(db.client, RECIPE, LOC)
    expect(detail.category).toEqual({ id: categoryId, name: 'Tapeo' })
    expect(detail.components[0]?.quantity).toBe(10)
    expect(db.tables).toContain('recipe_categories')
    expect(db.tables).not.toContain('inventory_movements')
  })

  it('mantiene el modo de consumo y marca costo incompleto si hay cantidades válidas e inválidas', async () => {
    const db = client({
      mappings: [mappingRow],
      recipes: [recipeRow],
      components: [
        {
          id: COMPONENT,
          recipe_id: RECIPE,
          inventory_product_id: PRODUCT,
          component_recipe_id: null,
          quantity: 10,
        },
        {
          id: COMPONENT_B,
          recipe_id: RECIPE,
          inventory_product_id: PRODUCT,
          component_recipe_id: null,
          quantity: 'n/a',
        },
      ],
      products: [{ id: PRODUCT, organization_id: ORG, name: 'Malta', base_unit: 'g' }],
      locationInventory: [{ id: LI, location_id: LOC, inventory_product_id: PRODUCT }],
      valuations: [{ location_inventory_id: LI, average_unit_cost: 1.5 }],
    })

    const detail = await recipeQuery.getRecipeDetail(db.client, RECIPE, LOC)
    expect(detail.consumptionMode).toBe('compound')
    expect(detail.componentCount).toBe(2)
    expect(detail.costIncomplete).toBe(true)
    expect(detail.costPerYield).toBeNull()
    expect(detail.hasInvalidQuantities).toBe(true)
    expect(detail.components).toEqual([
      {
        id: COMPONENT,
        inventoryProductId: PRODUCT,
        componentRecipeId: null,
        name: 'Malta',
        baseUnit: 'g',
        quantity: 10,
        unitCost: 1.5,
        lineCost: 15,
        costMissing: false,
      },
      {
        id: COMPONENT_B,
        inventoryProductId: PRODUCT,
        componentRecipeId: null,
        name: 'Malta',
        baseUnit: 'g',
        quantity: 0,
        unitCost: 1.5,
        lineCost: null,
        costMissing: true,
      },
    ])
  })

  it('permite consultar una receta de la organización aunque no esté mapeada en el local', async () => {
    const db = client({
      mappings: [],
      recipes: [recipeRow],
      components: [],
    })
    const detail = await recipeQuery.getRecipeDetail(db.client, RECIPE, LOC)
    expect(detail.mapping).toBeNull()
    expect(detail.costPerYield).toBe(0)
    expect(detail.costIncomplete).toBe(false)
    expect(detail.hasInvalidQuantities).toBe(false)
    expect(detail.sharedLocationCount).toBe(0)
  })

  it('propaga el error de valuación y no completa el costo con cero', async () => {
    const db = client({
      mappings: [mappingRow],
      recipes: [recipeRow],
      components: [{
        id: COMPONENT,
        recipe_id: RECIPE,
        inventory_product_id: PRODUCT,
        quantity: 2,
      }],
      locationInventory: [{ id: LI, location_id: LOC, inventory_product_id: PRODUCT }],
      valuationsError: { message: 'permission denied for table inventory_valuations' },
    })
    await expect(recipeQuery.getRecipeDetail(db.client, RECIPE, LOC)).rejects.toMatchObject({
      message: 'No se pudieron consultar los costos.',
      code: 'LOOKUP_FAILED',
      status: 500,
    })
  })
})

describe('listOrganizationRecipes', () => {
  it('no consulta recetas si la organización no es visible por JWT', async () => {
    const db = client({ organizations: [] })
    await expect(recipeQuery.listOrganizationRecipes(db.client, ORG)).resolves.toBeNull()
    expect(db.tables).toEqual(['organizations'])
  })

  it('lista recetas activas de venta sin exigir mapping del local', async () => {
    const db = client({
      recipes: [
        recipeRow,
        {
          ...recipeRow,
          id: NESTED,
          name: 'Jarabe de preparación',
          recipe_type: 'preparation',
        },
        {
          ...recipeRow,
          id: 'abababab-abab-4aba-8aba-abababababab',
          name: 'IPA inactiva',
          active: false,
        },
        {
          ...recipeRow,
          organization_id: OTHER_ORG,
          id: 'acacacac-acac-4aca-8aca-acacacacacac',
          name: 'Otra org',
        },
      ],
      components: [{
        id: COMPONENT,
        recipe_id: RECIPE,
        inventory_product_id: PRODUCT,
        quantity: 0.5,
      }],
    })
    const items = await recipeQuery.listOrganizationRecipes(db.client, ORG)
    expect(items).toEqual([{
      id: RECIPE,
      name: 'IPA de barril',
      recipeType: 'sale_product',
      active: true,
      yieldQuantity: 1,
      yieldUnit: 'unit',
      consumptionMode: 'direct',
      componentCount: 1,
      category: null,
    }])
    expect(db.tables).not.toContain('sales_product_mappings')
    expect(db.tables).not.toContain('location_inventory')
    expect(db.tables).not.toContain('inventory_valuations')
    expect(JSON.stringify(items)).not.toMatch(/salePrice/)
  })

  it('filtra por nombre y no ofrece recetas inactivas o de preparación', async () => {
    const db = client({
      recipes: [
        recipeRow,
        { ...recipeRow, id: NESTED, name: 'Pinta IPA' },
        {
          ...recipeRow,
          id: 'abababab-abab-4aba-8aba-abababababab',
          name: 'Pinta IPA inactiva',
          active: false,
        },
        {
          ...recipeRow,
          id: 'acacacac-acac-4aca-8aca-acacacacacac',
          name: 'Pinta IPA preparación',
          recipe_type: 'preparation',
        },
      ],
      components: [],
    })
    const items = await recipeQuery.listOrganizationRecipes(db.client, ORG, { search: 'pinta' })
    expect(items?.map((row) => row.name)).toEqual(['Pinta IPA'])
    expect(items?.[0]?.consumptionMode).toBe('none')
    expect(items?.[0]?.category).toBeNull()
  })

  it('incluye la categoría de la organización y deja sin categoría las recetas viejas', async () => {
    const categoryId = '15151515-1515-4151-8151-151515151515'
    const db = client({
      recipes: [
        { ...recipeRow, category_id: categoryId },
        {
          ...recipeRow,
          id: NESTED,
          name: 'Agua',
          category_id: null,
        },
      ],
      components: [],
      categories: [{
        id: categoryId,
        organization_id: ORG,
        name: 'Tapeo',
      }, {
        id: categoryId,
        organization_id: OTHER_ORG,
        name: 'Ajena',
      }],
    })
    const items = await recipeQuery.listOrganizationRecipes(db.client, ORG)
    expect(items?.find((row) => row.name === 'IPA de barril')?.category).toEqual({
      id: categoryId,
      name: 'Tapeo',
    })
    expect(items?.find((row) => row.name === 'Agua')?.category).toBeNull()
  })

  it('incluye recetas inactivas solo si se pide explícitamente', async () => {
    const inactiveId = 'abababab-abab-4aba-8aba-abababababab'
    const db = client({
      recipes: [
        recipeRow,
        { ...recipeRow, id: inactiveId, name: 'IPA inactiva', active: false },
      ],
      components: [],
    })
    const activeOnly = await recipeQuery.listOrganizationRecipes(db.client, ORG)
    expect(activeOnly?.map((row) => row.name)).toEqual(['IPA de barril'])
    const withInactive = await recipeQuery.listOrganizationRecipes(db.client, ORG, {
      includeInactive: true,
    })
    expect(withInactive?.map((row) => row.name)).toEqual(['IPA de barril', 'IPA inactiva'])
    expect(withInactive?.find((row) => row.id === inactiveId)?.active).toBe(false)
  })
})

describe('getRecipeUsage', () => {
  it('no consulta uso si la organización no es visible por JWT', async () => {
    const db = client({ organizations: [] })
    await expect(recipeQuery.getRecipeUsage(db.client, ORG, RECIPE)).resolves.toBeNull()
    expect(db.tables).toEqual(['organizations'])
  })

  it('lista padres activos y mappings Fudo sin escribir stock', async () => {
    const db = client({
      recipes: [
        recipeRow,
        { ...recipeRow, id: NESTED, name: 'Milanesa napolitana', active: true },
        {
          ...recipeRow,
          id: 'abababab-abab-4aba-8aba-abababababab',
          name: 'Guiso archivado',
          active: false,
        },
      ],
      components: [
        { recipe_id: NESTED, component_recipe_id: RECIPE },
        { recipe_id: 'abababab-abab-4aba-8aba-abababababab', component_recipe_id: RECIPE },
      ],
      mappings: [mappingRow, { ...mappingRow, id: MAPPING_B, active: false }],
    })
    const usage = await recipeQuery.getRecipeUsage(db.client, ORG, RECIPE)
    expect(usage).toEqual({
      recipeId: RECIPE,
      active: true,
      usedBy: [{ recipeId: NESTED, name: 'Milanesa napolitana' }],
      activeMappingCount: 1,
    })
    expect(db.tables).not.toContain('inventory_movements')
    expect(db.tables).not.toContain('pending_product_mappings')
  })

  it('no expone una receta de otra organización', async () => {
    const db = client({
      recipes: [{ ...recipeRow, organization_id: OTHER_ORG }],
    })
    await expect(recipeQuery.getRecipeUsage(db.client, ORG, RECIPE)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
    })
  })
})

describe('listOrganizationRecipeCategories', () => {
  it('no consulta categorías si la organización no es visible por JWT', async () => {
    const db = client({ organizations: [] })
    await expect(recipeQuery.listOrganizationRecipeCategories(db.client, ORG)).resolves.toBeNull()
    expect(db.tables).toEqual(['organizations'])
  })

  it('devuelve vacío si la organización no tiene categorías', async () => {
    const db = client({ categories: [] })
    await expect(recipeQuery.listOrganizationRecipeCategories(db.client, ORG)).resolves.toEqual([])
  })

  it('lista categorías reales y no inventa nombres predefinidos', async () => {
    const db = client({
      categories: [
        { id: '15151515-1515-4151-8151-151515151515', organization_id: ORG, name: 'Tapeo' },
        { id: '16161616-1616-4161-8161-161616161616', organization_id: OTHER_ORG, name: 'Ajena' },
      ],
    })
    const items = await recipeQuery.listOrganizationRecipeCategories(db.client, ORG)
    expect(items).toEqual([{ id: '15151515-1515-4151-8151-151515151515', name: 'Tapeo' }])
    expect(JSON.stringify(items)).not.toMatch(/Entradas|Platos principales|Postres/)
  })

  it('si el esquema todavía no existe devuelve vacío', async () => {
    const db = client({
      categoriesError: {
        code: 'PGRST205',
        message: 'Could not find the table public.recipe_categories in the schema cache',
      },
    })
    await expect(recipeQuery.listOrganizationRecipeCategories(db.client, ORG)).resolves.toEqual([])
  })
})
