import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The frontend talks to the backend only through /api, proxied to API_URL so
// the session cookie is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      "/api": process.env.API_URL ?? "http://localhost:3000",
    },
  },
});
