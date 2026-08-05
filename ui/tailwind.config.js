/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter var', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        display: ['Syne', 'sans-serif'],
      },
      colors: {
        brand: {
          50:  '#f0f4ff',
          100: '#dce6ff',
          200: '#b9cdff',
          300: '#85a7ff',
          400: '#4d77ff',
          500: '#1a47f5',
          600: '#0a30e0',
          700: '#0920b5',
          800: '#0c1d8f',
          900: '#0e1b70',
          950: '#090f44',
        },
        surface: {
          0:   '#ffffff',
          50:  '#f8f9fb',
          100: '#f1f3f7',
          200: '#e4e8f0',
          300: '#cdd3df',
          400: '#9ca3b4',
          500: '#6b7280',
          600: '#4b5563',
          700: '#374151',
          800: '#1c2233',
          900: '#111827',
          950: '#080d17',
        },
        success: { 50: '#ecfdf5', 500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46' },
        warning: { 50: '#fffbeb', 500: '#f59e0b', 600: '#d97706', 700: '#b45309' },
        danger:  { 50: '#fef2f2', 200: '#fecaca', 500: '#ef4444', 600: '#dc2626', 700: '#b91c1c' },
      },
      boxShadow: {
        card: '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.06)',
        'card-hover': '0 4px 12px 0 rgb(0 0 0 / 0.10)',
        panel: '0 0 0 1px rgb(0 0 0 / 0.06), 0 4px 16px -2px rgb(0 0 0 / 0.08)',
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
    },
  },
  plugins: [],
}
