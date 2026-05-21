import { defineConfig } from 'vite'
import { devvit } from '@devvit/start/vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({ plugins: [devvit(), react(), tailwindcss()] })
