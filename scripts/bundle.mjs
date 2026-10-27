import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const mode = process.argv[2] || "all";

function readGitInfo() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
    return { commit, dirty: status !== "" };
  } catch {
    return { commit: "unknown", dirty: false };
  }
}

const git = readGitInfo();

/** @type {esbuild.BuildOptions} */
const commonOptions = {
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
  define: {
    "process.env.QAQH_GIT_COMMIT": JSON.stringify(git.commit),
    "process.env.QAQH_GIT_DIRTY": JSON.stringify(git.dirty ? "1" : "0"),
  },
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
