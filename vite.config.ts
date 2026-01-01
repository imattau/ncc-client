import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "node:crypto": resolve(__dirname, "src/shims/nodeCrypto.ts"),
      "ncc-06-js": resolve(__dirname, "src/shims/ncc06-browser.ts")
    }
  },
  plugins: [react()],
  server: {
    port: 4173
  }
});
