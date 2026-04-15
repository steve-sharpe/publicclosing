/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      colors: {
        nvh: {
          bg: '#05070A',
          navy: '#0B1220',
          panel: '#111827',
          red: '#E11B22',
          redDark: '#B31218',
          text: '#FFFFFF',
          muted: '#BFC7D5',
        },
      },
      fontFamily: {
        sans: ['Montserrat', 'Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
  // Safelist dynamic classes (returned from helper functions)
  safelist: [
    // legacy
    'bg-emerald-600', 'bg-amber-600', 'bg-blue-600', 'bg-rose-700', 'bg-slate-700', 'bg-opacity-40',
    // NVH themed status badges
    'bg-nvh-red', 'border-nvh-redDark', 'bg-nvh-redDark', 'border-nvh-red',
    'bg-white/10', 'border-white/20',
    'bg-slate-600', 'border-slate-500',
    'bg-slate-500', 'border-slate-400',
    // NVH themed status backgrounds
    'bg-nvh-red/15', 'bg-nvh-redDark/20', 'bg-white/5', 'bg-slate-800/40',
  ],
}
