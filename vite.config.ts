import { defineConfig } from 'vite'
import { devvit } from '@devvit/start/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig(({ command }) => {
  const isServe = command === 'serve'
  return {
    plugins: [...(isServe ? [] : [devvit()]), react(), tailwindcss()],
    root: isServe ? resolve(__dirname, 'src/client') : undefined,
    server: isServe ? {
      port: 5173,
      proxy: { '/api': 'http://localhost:4173' },
    } : undefined,
    build: {
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return
          warn(warning)
        },
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return
            if (id.includes('three') || id.includes('@react-three') || id.includes('postprocessing')) return 'three'
            if (id.includes('@radix-ui')) return 'radix'
            if (id.includes('lucide-react')) return 'icons'
            if (id.includes('react-dom') || id.includes('/react/')) return 'react'
            if (id.includes('openai')) return 'openai'
            return 'vendor'
          },
        },
      },
    },
  }
})
