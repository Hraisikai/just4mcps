import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,   // bind to 0.0.0.0 so the container port is reachable
    port: 5173,
    watch: {
      // Docker volume mounts on Linux don't fire inotify events — use polling
      // so HMR actually picks up file changes.
      usePolling: true,
      interval: 300,
    },
  },
})
