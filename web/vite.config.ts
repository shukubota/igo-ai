import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // エンジンのURLは .env.local の VITE_API_BASE で上書きできる。
  // 既定はローカル起動のエンジン。
});
