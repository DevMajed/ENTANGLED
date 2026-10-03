import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    rollupOptions: { output: { manualChunks: { three: ['three'] } } },
    // Three.js is the main local graphics runtime; no remote runtime dependencies.
    chunkSizeWarningLimit: 700,
  },
});
