import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@worldact/wordpress-lock-unlock",
        replacement: fileURLToPath(new URL("./node_modules/@wordpress/block-editor/build-module/lock-unlock.mjs", import.meta.url)),
      },
      {
        find: /^@arraypress\/waveform-player\/no-autoinit$/,
        replacement: fileURLToPath(
          new URL("./src/boundedWaveformPlayer.ts", import.meta.url),
        ),
      },
    ],
  },
  optimizeDeps: {
    exclude: ["@arraypress/waveform-player/no-autoinit"],
    include: [
      "@arraypress/waveform-player/dist/waveform-player-no-autoinit.esm.js",
    ],
  },
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
