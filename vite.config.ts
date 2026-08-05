import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * The webview is a plain browser bundle. VS Code webviews cannot load ES modules
 * from disk reliably, so we emit predictable single-file names with no hashing
 * and let the panel reference them via `asWebviewUri`.
 */
export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src/webview'),
  build: {
    outDir: resolve(__dirname, 'dist/webview'),
    emptyOutDir: true,
    target: 'es2022',
    // Emit a real index.css instead of letting Vite inject styles from JS: the
    // panel HTML links it directly, and a stylesheet served from
    // `localResourceRoots` needs no CSP concession that JS injection would.
    cssCodeSplit: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/webview/main.tsx'),
      output: {
        entryFileNames: 'index.js',
        assetFileNames: 'index.[ext]',
        format: 'iife',
      },
    },
  },
});
