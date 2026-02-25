import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    open: true,
  },

  build: {
    // Target modern browsers — smaller output, native ESM
    target: 'es2020',

    // Raise the warning threshold so recharts doesn't trigger false alarms
    chunkSizeWarningLimit: 800,

    rollupOptions: {
      output: {
        // Split vendor chunks so recharts is cached independently from app code.
        // This means a code change doesn't bust the recharts cache on Netlify CDN.
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-recharts': ['recharts'],
        },
        // Hashed filenames enable long-lived Cache-Control: immutable on Netlify
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
