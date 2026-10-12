import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // 构建产物直接输出到 backend/public,由后端 Express 静态服务
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    // 开发模式代理到后端 API/WS
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
