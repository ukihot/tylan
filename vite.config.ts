import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'
import { standalonePlugin, viewerTemplatePlugin } from './build/standalone.ts'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: './',
  publicDir: false,
  plugins: [svelte(), viewerTemplatePlugin(), standalonePlugin(mode)],
  build: {
    outDir: mode === 'viewer' ? '.build/viewer' : 'dist',
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: Infinity,
    rolldownOptions: {
      input: mode === 'viewer' ? 'viewer.html' : 'index.html',
      output: { codeSplitting: false },
    },
  },
}))
