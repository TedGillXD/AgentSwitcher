import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { developmentCsp } from './shared/dev-csp';
export default defineConfig({ root: 'renderer', plugins: [react(), developmentCsp()] });
