/**
 * make-baseline —— shell 包的出厂基线 zip(resources/baseline/{app,backend}.zip)。
 *
 * 用途链路:系统 bootstrap 在加载业务 main 之前读取 baseline.json,
 * 按版本/内容身份协调用户 overlay;需要升级/修复时调用 qaqh-maint unpack。
 * postinst 的系统 seed 是独立副本,不参与用户启动选择。布局与 make-bundles 同一契约
 * (collect-bundle → qaqh-pack zip,target 前缀 app/ 与 backend/)。
 *
 * 用法: node scripts/make-baseline.mjs [--version <v>]
 * 前置: dist/ + renderer/ 已就绪(just build 的 1-4 步)、resources/bin/qaqh-daemon
 *       已就绪、qaqh-pack release 二进制已构建(build-all.mjs shell 分支负责)。
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { identifyBaseline } from "./baseline-metadata.mjs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectBundle } from "./collect-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "resources/baseline");
const workDir = resolve(root, ".qaqh-baseline");
const pack = resolve(root, "crates/qaqh-update/target/release/qaqh-pack");

function zip(bundleRoot, out) {
  const manifestPath = join(bundleRoot, "bundle.json");
  const manifest = identifyBaseline(JSON.parse(readFileSync(manifestPath, "utf8")));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const result = spawnSync(pack, ["zip", "--bundle", bundleRoot, "--out", out], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`qaqh-pack zip failed for ${bundleRoot}`);
  return {
    buildId: manifest.buildId, version: manifest.appVersion,
    bundle: out.endsWith("backend.zip") ? "backend.zip" : "app.zip",
    sha256: createHash("sha256").update(readFileSync(out)).digest("hex"),
    size: readFileSync(out).length,
  };
}

async function main() {
  if (!existsSync(pack)) {
    throw new Error(`qaqh-pack missing: ${pack}(先 cargo build --release --manifest-path crates/qaqh-update/Cargo.toml --bins)`);
  }
  const args = process.argv.slice(2);
  const version = args.includes("--version") ? args[args.indexOf("--version") + 1] : "0.0.0-baseline";
  const buildId = `baseline-${version}`;

  rmSync(outDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // app 基线:dist + renderer + package.json,与前端热更新包同一 target 前缀 app/。
  const appStaging = join(workDir, "app");
  mkdirSync(appStaging, { recursive: true });
  for (const entry of ["package.json", "dist", "renderer"]) {
    cpSync(join(root, entry), join(appStaging, entry), { recursive: true });
  }
  const appBundle = join(workDir, "bundle-app");
  await collectBundle([
    "--kind", "frontend", "--build-id", buildId, "--app-version", version,
    "--source", appStaging, "--target-prefix", "app", "--out", appBundle,
    "--component", `frontend=${buildId}`, "--control-protocol", "1",
    "--release-id", buildId, "--channel", "local",
    "--exec", "dist/main/index.cjs", "--exec", "dist/preload/index.cjs",
  ]);
  const frontend = zip(appBundle, join(outDir, "app.zip"));

  // backend 基线:resources/bin/qaqh-daemon。
  const daemon = resolve(root, "resources/bin/qaqh-daemon");
  if (!existsSync(daemon)) throw new Error(`qaqh-daemon missing: ${daemon}`);
  const backendStaging = join(workDir, "backend");
  mkdirSync(backendStaging, { recursive: true });
  cpSync(daemon, join(backendStaging, "qaqh-daemon"));
  const backendBundle = join(workDir, "bundle-backend");
  await collectBundle([
    "--kind", "backend", "--build-id", buildId, "--app-version", version,
    "--source", backendStaging, "--target-prefix", "backend", "--out", backendBundle,
    "--component", `backend=${buildId}`, "--control-protocol", "1",
    "--release-id", buildId, "--channel", "local",
    "--exec", "qaqh-daemon",
  ]);
  const backend = zip(backendBundle, join(outDir, "backend.zip"));
  const legalSourceDir = join(root, "resources/legal");
  const legalOutputDir = join(outDir, "legal");
  const legalManifestPath = join(legalSourceDir, "legal.json");
  let legal;
  if (existsSync(legalManifestPath)) {
    const manifest = JSON.parse(readFileSync(legalManifestPath, "utf8"));
    const documents = {};
    mkdirSync(legalOutputDir, { recursive: true });
    for (const name of ["userAgreement", "privacyPolicy"]) {
      const entry = manifest.documents?.[name];
      if (!entry?.file || !entry.sha256) {
        throw new Error(`legal manifest is missing ${name} file/sha256`);
      }
      if (!/^[A-Za-z0-9_.-]+$/.test(entry.file)) throw new Error(`invalid legal filename: ${entry.file}`);
      const body = readFileSync(join(legalSourceDir, entry.file));
      const actual = createHash("sha256").update(body).digest("hex");
      if (actual !== entry.sha256) throw new Error(`legal document checksum mismatch: ${entry.file}`);
      documents[name] = { file: entry.file, sha256: actual };
      writeFileSync(join(legalOutputDir, entry.file), body);
    }
    legal = { version: manifest.version, documents };
  }
  const baseline = {
    formatVersion: 1,
    components: { frontend, backend },
    ...(legal ? { legalVersion: legal.version, legal } : {}),
  };
  writeFileSync(join(outDir, "baseline.json"), JSON.stringify(baseline, null, 2) + "\n");

  rmSync(workDir, { recursive: true, force: true });
  console.log(`baseline ready: ${outDir} (app.zip + backend.zip, buildId=${buildId})`);
}

main().catch((error) => {
  console.error(`\nmake-baseline FAILED: ${error.message}`);
  process.exitCode = 1;
});
