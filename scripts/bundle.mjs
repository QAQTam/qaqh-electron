import * as esbuild from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const mode = process.argv[2] || "all";

/** @type {esbuild.BuildOptions} */
const commonOptions = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};

async function buildMain() {
  console.log("[bundle] Building main process...");
  await esbuild.build({
    ...commonOptions,
    entryPoints: [resolve(root, "src/main/index.ts")],
    outfile: resolve(root, "dist/main/index.cjs"),
    format: "cjs",
  });
}

async function buildPreload() {
  console.log("[bundle] Building preload script...");
  await esbuild.build({
    ...commonOptions,
    entryPoints: [resolve(root, "src/preload/index.ts")],
    outfile: resolve(root, "dist/preload/index.cjs"),
    format: "cjs",
  });
}

async function run() {
  if (mode === "main" || mode === "all") {
    await buildMain();
  }
  if (mode === "preload" || mode === "all") {
    await buildPreload();
  }
  console.log("[bundle] Build completed successfully.");
}

run().catch((err) => {
  console.error("[bundle] Build failed:", err);
  process.exit(1);
});
