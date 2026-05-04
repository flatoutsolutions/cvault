import tailwindcss from '@tailwindcss/vite'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

const config = defineConfig({
  envDir: '..',
  envPrefix: ['VITE_'],
  // Force a single React instance across all chunks. Without this, the
  // code-split lazy routes (createLazyFileRoute) can pick up a second copy
  // of `react` via transitive dependencies, which produces "Invalid hook
  // call" + "Cannot read properties of null (reading 'useState')" — React's
  // hook dispatcher is per-module, and two copies = two dispatchers, so
  // hooks called against module A see B's null dispatcher.
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client'],
  },
  plugins: [
    devtools(),
    tsconfigPaths({ projects: ['../tsconfig.app.json'] }),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
        prerender: {
          crawlLinks: true,
        },
      },
      prerender: {
        failOnError: false,
      },
    }),
    viteReact({
      babel: {
        plugins: ['babel-plugin-react-compiler'],
      },
    }),
  ],
})

export default config
