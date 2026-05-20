import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          // Stdio bridge for the MCP delegation endpoint. Bundles to
          // out/main/mcp-stdio.js so external agent frameworks can spawn it
          // as a child process. See MCP_DELEGATION.md.
          "mcp-stdio": resolve(__dirname, "src/main/Mcp/blueberryMcpCli.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          topbar: resolve(__dirname, "src/preload/topbar.ts"),
          sidebar: resolve(__dirname, "src/preload/sidebar.ts"),
          tabRecorder: resolve(__dirname, "src/preload/tabRecorder.ts"),
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      rollupOptions: {
        input: {
          topbar: resolve(__dirname, "src/renderer/topbar/index.html"),
          sidebar: resolve(__dirname, "src/renderer/sidebar/index.html"),
        },
      },
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@common": resolve("src/renderer/common"),
      },
    },
    plugins: [react()],
    server: {
      fs: {
        allow: [".."],
      },
    },
  },
});
