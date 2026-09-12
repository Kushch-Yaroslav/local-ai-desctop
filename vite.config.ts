import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  // Electron opens this file through file:// in normal desktop mode. Relative
  // asset URLs are required; Vite's default /assets path only works via HTTP.
  base: './',
  plugins: [react()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  server: { port: 5173, strictPort: true },
});
