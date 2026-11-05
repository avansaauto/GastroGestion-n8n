/**
 * Paleta de marca SENDA OPS.
 *
 * Anclas:
 *   naranja    #FF4C00  primary-500  (CTA, selección, acento)
 *   azul       #0A1A2E  secondary-800 / navy (estructura, texto)
 *   crema      #FDF9F4  fondos
 */
export const brandPrimary = '#FF4C00' as const
export const brandAccent = '#FD5B01' as const
export const brandNavy = '#0A1A2E' as const
export const brandCream = '#FDF9F4' as const
export const brandCreamSoft = '#FCF8F2' as const
export const brandInk = brandNavy
/** @deprecated usar brandPrimary (naranja) */
export const brandSecondary = brandNavy

export const primary = {
  50: '#FFF5F0',
  100: '#FFE8DE',
  200: '#FFC9B3',
  300: '#FF9A70',
  400: '#FF6B33',
  500: brandPrimary,
  600: '#E04400',
  700: '#C23A00',
  800: '#9A2F00',
  900: '#7A2600',
  950: '#4A1600',
} as const

export const secondary = {
  50: '#F2F5F8',
  100: '#E4EAF0',
  200: '#C5D0DC',
  300: '#8FA3B8',
  400: '#5A738C',
  500: '#2A4060',
  600: '#1A2F4A',
  700: '#0F2438',
  800: brandNavy,
  900: '#071320',
  950: '#040B14',
} as const

export const primaryDark = {
  50: '#2A1008',
  100: '#3D180A',
  200: '#5C240E',
  300: '#7A2600',
  400: '#C23A00',
  500: brandPrimary,
  600: '#FF6B33',
  700: '#FF9A70',
  800: '#FFC9B3',
  900: '#FFE8DE',
  950: '#FFF5F0',
} as const

export const secondaryDark = {
  50: '#040B14',
  100: '#071320',
  200: brandNavy,
  300: '#0F2438',
  400: '#1A2F4A',
  500: '#2A4060',
  600: '#5A738C',
  700: '#8FA3B8',
  800: '#C5D0DC',
  900: '#E4EAF0',
  950: '#F2F5F8',
} as const

export type PaletteStep = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950
