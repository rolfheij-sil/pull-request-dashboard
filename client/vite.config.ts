import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { WEB_PORT } from '../src/web-port';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: WEB_PORT,
    proxy: { '/api': 'http://127.0.0.1:5174' },
  },
});
