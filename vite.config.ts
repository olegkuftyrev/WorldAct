import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    cors: false,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/uploads": "http://127.0.0.1:3001",
      "/wp-json": "http://127.0.0.1:3001",
      "/wp-admin": "http://127.0.0.1:3001",
      "/wp-login.php": "http://127.0.0.1:3001",
      "/wp-comments-post.php": "http://127.0.0.1:3001",
      "/public-login": "http://127.0.0.1:3001",
      "/logout": "http://127.0.0.1:3001",
      "/post-password": "http://127.0.0.1:3001",
      "/feed": "http://127.0.0.1:3001",
      "/comments/feed": "http://127.0.0.1:3001",
      "/sitemap.xml": "http://127.0.0.1:3001",
      "/robots.txt": "http://127.0.0.1:3001",
    },
  },
});
