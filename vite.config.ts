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
    optimizeDeps: isServe ? {
      include: [
        'react', 'react-dom', 'react-dom/client',
        'lucide-react', 'react-day-picker', 'react-markdown', 'remark-gfm',
        'three', '@react-three/fiber', '@react-three/drei', '@react-three/postprocessing', 'postprocessing',
      ],
    } : undefined,
    build: {
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return
          warn(warning)
        },
      },
    },
  }
})
