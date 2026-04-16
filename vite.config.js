import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/graphql': {
        target: 'https://www.editbynine.com',
        changeOrigin: true,
        secure: true
      },
      '/rest': {
        target: 'https://www.editbynine.com',
        changeOrigin: true,
        secure: true
      }
    }
  }
})