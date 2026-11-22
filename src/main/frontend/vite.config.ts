import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: '../../../target/classes/assets/next',
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'next.js',
        assetFileNames: (info) => (info.names?.some((n) => n.endsWith('.css')) ? 'next.css' : '[name][extname]'),
      },
    },
  },
});
