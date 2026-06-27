import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:9886',
      '/outputs': 'http://127.0.0.1:9886',
      '/assets': 'http://127.0.0.1:9886',
    },
    watch: {
      usePolling: true,
    },
  },
})
