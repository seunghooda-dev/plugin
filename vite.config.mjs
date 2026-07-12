import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  publicDir: "public",
  build: {
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve(import.meta.dirname, "index.ts"),
      formats: ["cjs"],
      fileName: () => "index.js"
    },
    rollupOptions: {
      external: ["premierepro", "uxp", "path"],
      output: {
        exports: "named"
      }
    }
  }
});
