// Bundles the worker and the operational scripts into dist/ with esbuild.
// The Docker image runs them with plain `node`, next to the Next.js
// standalone server.
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

await build({
  entryPoints: {
    worker: "src/workers/main.ts",
    "worker-healthcheck": "src/workers/healthcheck.ts",
    migrate: "src/scripts/migrate.ts",
    "directory-sync": "src/scripts/directory-sync.ts",
    "taxonomy-import": "src/scripts/taxonomy-import.ts",
    replay: "src/scripts/replay.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node26",
  format: "esm",
  sourcemap: true,
  tsconfig: "tsconfig.json",
  // Optional native binding of pg; never installed.
  external: ["pg-native"],
  // Bundled CommonJS dependencies call require().
  banner: {
    js: "import { createRequire as __libraryCreateRequire } from 'node:module'; const require = __libraryCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

// Debug IDs in the bundles and their source maps, as Turbopack writes them for
// the web process (next.config.ts): Sentry matches an error's frames to the
// source maps that release builds upload (Dockerfile). Uploads nothing.
execFileSync("node_modules/.bin/sentry", ["sourcemap", "inject", "dist"], {
  stdio: "inherit",
  env: { ...process.env, SENTRY_CLI_NO_TELEMETRY: "1", SENTRY_CLI_NO_UPDATE_CHECK: "1" },
});
