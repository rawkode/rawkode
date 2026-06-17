import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: '../Sources/Shared/Resources/Editor',
    emptyOutDir: false,
    sourcemap: false,
    chunkSizeWarningLimit: 2200,
  },
});
