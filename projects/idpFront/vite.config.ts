import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** `npm run dev` serves the page itself and hands the gateway's paths to a gateway on :3000. */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
});
