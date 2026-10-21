import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { developmentCsp } from './shared/dev-csp';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('electron/main.ts'), output: { entryFileNames: 'index.js' } } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('electron/preload.ts'), output: { format: 'cjs', entryFileNames: 'index.cjs' } } },
  },
  renderer: {
    root: 'renderer',
    plugins: [react(), developmentCsp()],
    build: { rollupOptions: { input: resolve('renderer/index.html') } },
  },
});
