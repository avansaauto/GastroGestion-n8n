/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        senda: {
          canvas: 'var(--senda-canvas)',
          surface: 'var(--senda-surface)',
          subtle: 'var(--senda-subtle)',
          border: 'var(--senda-border)',
          'border-strong': 'var(--senda-border-strong)',
          ink: 'var(--senda-ink)',
          muted: 'var(--senda-muted)',
          navy: 'var(--senda-navy)',
          orange: 'var(--senda-orange)',
        },
      },
      fontFamily: {
        sans: ['Manrope', 'ui-sans-serif', 'system-ui'],
      },
      fontSize: {
        'display': ['1.75rem', { lineHeight: '1.15', letterSpacing: '-0.03em', fontWeight: '800' }],
        'title': ['1.125rem', { lineHeight: '1.3', letterSpacing: '-0.02em', fontWeight: '700' }],
      },
      borderRadius: {
        control: 'var(--radius-control)',
        card: 'var(--radius-card)',
      },
      boxShadow: {
        sm: 'var(--senda-shadow-sm)',
        panel: 'var(--senda-shadow-panel)',
        raised: 'var(--senda-shadow-raised)',
      },
      spacing: {
        sidebar: 'var(--sidebar-width)',
        'sidebar-collapsed': 'var(--sidebar-collapsed)',
        'sidebar-expanded': 'var(--sidebar-expanded)',
        'sidebar-gap': 'var(--sidebar-gap)',
      },
      maxWidth: {
        content: 'var(--content-max)',
      },
    },
  },
  plugins: [],
}
