import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5180,
    host: true,
    allowedHosts: true
  },
  build: {
    target: 'esnext',
    outDir: 'dist'
  }
});
