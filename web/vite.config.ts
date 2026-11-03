import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base relativo: funciona no GitHub Pages (usuario.github.io/repositorio/) e em qualquer host estático
export default defineConfig({
  plugins: [react()],
  base: "./",
});
