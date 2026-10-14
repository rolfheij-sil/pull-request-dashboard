import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { WEB_PORT } from '../src/web-port';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: WEB_PORT,
    // The API's Origin and Host checks accept only this port, so Vite must not
    // quietly move to another one when it is taken.
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:5174' },
  },
});
