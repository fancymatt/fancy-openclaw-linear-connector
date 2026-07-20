import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served by the connector under /admin — assets must resolve from there.
export default defineConfig({
  plugins: [react()],
  base: "/admin/",
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      // Local dev loop: `PORT=3199 node dist/index.js` in the repo root,
      // then `npm run dev` here.
      "/admin/api": "http://localhost:3199",
    },
  },
  optimizeDeps: {
    exclude: ["@fancyfleet/components", "@fancyfleet/tokens"],
  },
});
