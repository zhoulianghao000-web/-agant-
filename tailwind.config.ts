import type { Config } from 'tailwindcss';

/**
 * 与 design-tokens.css 保持同源：这里的色值必须与 CSS 变量一致。
 * 单点真源仍是 CSS 变量；此处的映射仅用于 Tailwind 工具类（bg-surface 等）。
 * 修改任一色值必须同时改两处 —— 这是本文件唯一的维护成本，换取的是
 * 「业务代码不出现硬编码色值」这条规则可被 lint 人工核查。
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#E6FAFF',
          100: '#C2F2FF',
          200: '#8AE6FF',
          300: '#4FD8FF',
          400: '#1CCBFF',
          500: '#00C2FF',
          600: '#00A3D6',
          700: '#0082AD',
          800: '#006184',
          900: '#003F57',
          DEFAULT: '#00C2FF',
        },
        bg: { base: '#0B0B0E', elevated: '#121216', sunken: '#101013' },
        surface: { DEFAULT: '#17171C', hover: '#1F1F26' },
        content: {
          primary: '#FFFFFF',
          secondary: '#9CA0AA',
          tertiary: '#8A8F99',
          disabled: '#6B6F79',
          onbrand: '#0B0B0E',
        },
        success: '#34D399',
        warning: '#FBBF24',
        danger: '#F87171',
        info: '#4D6BFE',
        marketing: '#7B5CFF',
      },
      borderRadius: { sm: '6px', md: '8px', lg: '10px', xl: '12px', '2xl': '16px' },
      fontFamily: {
        sans: ['Inter', 'PingFang SC', 'HarmonyOS Sans', 'Microsoft YaHei', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      transitionDuration: { instant: '120ms', fast: '180ms', base: '240ms', slow: '320ms' },
      zIndex: { sidebar: '10', header: '20', popover: '40', drawer: '60', modal: '100', toast: '120' },
    },
  },
  plugins: [],
} satisfies Config;
