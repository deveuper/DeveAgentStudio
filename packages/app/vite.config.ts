import { sentryVitePlugin } from "@sentry/vite-plugin"
import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  plugins: [desktopPlugin, sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    sourcemap: true,
    rollupOptions: {
      output: {
        // Code-split heavy vendor libs out of the initial main chunk so the
        // application shell loads faster and the remaining chunks stay under
        // the 500 kB warning threshold. Static imports keep behaviour intact;
        // the browser fetches these in parallel.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined
          if (id.includes("@opencode-ai/ui") || id.includes("@kobalte")) return "vendor-ui"
          if (id.includes("ghostty-web") || id.includes("node-pty")) return "vendor-terminal"
          if (id.includes("solid-js") || id.includes("@solidjs") || id.includes("@solid-primitives")) return "vendor-solid"
          return undefined
        },
      },
    },
  },
})
