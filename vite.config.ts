import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * 环境策略（对应实施计划 0.6「三套环境」）
 *   dev       → npm run dev                （本地，mock 优先）
 *   staging   → npm run build:staging      （预发，连 staging-api）
 *   prod      → npm run build              （生产，连 api）
 * 三套的差异全部通过 VITE_* 变量注入，代码内不出现环境名的分支判断。
 */
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: mode !== 'production',
    // 模块级懒加载友好的分包：vendor 与业务代码分离，避免任一模块改动打穿全量缓存
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-gsap': ['gsap', '@gsap/react'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
}));
