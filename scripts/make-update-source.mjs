/**
 * make-update-source —— 把 .qaqh-bundles/<releaseId>/ 组装成 updater 可读的
 * update-source（bundles/ + catalog.json），即 qaqh-update stage 的输入端。
 *
 * 输入布局（make-bundles.mjs 产物）：
 *   .qaqh-bundles/<releaseId>/
 *     frontend-<build>/bundle.json   ← collect-bundle 产物（含 components 元数据）
 *     backend-<build>/bundle.json
 *     bundles/<build>.zip            ← qaqh-pack zip 产物
 *
 * 输出布局（与 crates/qaqh-update/src/source.rs 的 DirectoryUpdateSource 契约一致）：
 *   <out>/catalog.json               ← formatVersion 1 / components / artifacts
 *   <out>/bundles/<build>.zip        ← 按目录原样拷贝（payload 路径 bundles/<file>）
 *
 * artifact 语义：kind=frontend → restartPolicy electron（重启壳）；
 *               kind=backend  → restartPolicy daemon（只重启 daemon）。
 * 用法：
 *   node scripts/make-update-source.mjs [--release <releaseId>] [--out <dir>]
 *   （--release 缺省取 .qaqh-bundles/ 下最新修改的 release 目录）
 */
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { basename, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundlesRoot = resolve(root, ".qaqh-bundles");

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

/** 组装 catalog 对象（不落盘，测试直接消费）。 */
export function buildCatalog(releaseDir, { publishedAt } = {}) {
  const manifestDirs = readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(releaseDir, entry.name, "bundle.json")))
    .map((entry) => entry.name)
    .sort();
  if (manifestDirs.length === 0) {
    throw new Error(`no bundle.json under ${releaseDir}（先跑 just bundle-components）`);
  }

  const components = {};
  const artifacts = [];
  for (const name of manifestDirs) {
    const manifest = JSON.parse(readFileSync(join(releaseDir, name, "bundle.json"), "utf8"));
    const zipPath = join(releaseDir, "bundles", `${manifest.buildId}.zip`);
    if (!existsSync(zipPath)) {
      throw new Error(`missing zip for bundle ${manifest.buildId}: ${zipPath}`);
    }
    Object.assign(components, manifest.components);
    const kind = manifest.kind;
    if (!manifest.components[kind]) {
      throw new Error(`bundle ${manifest.buildId} (kind=${kind}) 缺少自身组件的元数据`);
    }
    artifacts.push({
      id: kind,
      kind,
      strategy: "component-full",
      targets: Object.fromEntries(
        Object.entries(manifest.components).map(([component, meta]) => [component, meta.buildId]),
      ),
      requires: { controlProtocol: manifest.components[kind].controlProtocol ?? undefined },
      restartPolicy: kind === "backend" ? "daemon" : "electron",
      payload: {
        path: `bundles/${basename(zipPath)}`,
        size: statSync(zipPath).size,
        sha256: sha256File(zipPath),
      },
    });
  }

  const catalog = {
    formatVersion: 1,
    releaseId: basename(releaseDir),
    channel: "local",
    publishedAt: publishedAt ?? new Date().toISOString(),
    components,
    artifacts,
  };
  validateCatalogShape(catalog);
  return catalog;
}

/** 与 crates/qaqh-update/src/model.rs::Catalog::validate 同口径的先验检查。 */
export function validateCatalogShape(catalog) {
  if (catalog.formatVersion !== 1) throw new Error("formatVersion must be 1");
  if (!catalog.releaseId) throw new Error("releaseId is empty");
  if (!Array.isArray(catalog.artifacts) || catalog.artifacts.length === 0) {
    throw new Error("catalog contains no artifacts");
  }
  for (const artifact of catalog.artifacts) {
    if (!artifact.id || Object.keys(artifact.targets ?? {}).length === 0) {
      throw new Error(`artifact ${artifact.id} 缺 id 或 targets`);
    }
    if (!/^[0-9a-f]{64}$/i.test(artifact.payload?.sha256 ?? "")) {
      throw new Error(`artifact ${artifact.id} 的 sha256 不是 64 位十六进制`);
    }
    for (const [component, buildId] of Object.entries(artifact.targets)) {
      if (catalog.components[component]?.buildId !== buildId) {
        throw new Error(
          `artifact ${artifact.id} targets ${component}=${buildId}, 但 catalog components 不一致`,
        );
      }
    }
  }
}

function latestReleaseDir() {
  if (!existsSync(bundlesRoot)) {
    throw new Error(`${bundlesRoot} 不存在（先跑 just bundle-components）`);
  }
  const releases = readdirSync(bundlesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "staging")
    .map((entry) => join(bundlesRoot, entry.name))
    .filter((dir) => readdirSync(dir, { withFileTypes: true })
      .some((child) => child.isDirectory() && existsSync(join(dir, child.name, "bundle.json"))));
  if (releases.length === 0) throw new Error("no release dirs with bundle.json");
  return releases.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

export function writeUpdateSource(releaseDir, outDir) {
  const catalog = buildCatalog(releaseDir);
  mkdirSync(join(outDir, "bundles"), { recursive: true });
  for (const artifact of catalog.artifacts) {
    copyFileSync(
      join(releaseDir, artifact.payload.path),
      join(outDir, artifact.payload.path),
    );
  }
  writeFileSync(join(outDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
  return catalog;
}

function main() {
  const args = process.argv.slice(2);
  const releaseFlag = args.indexOf("--release");
  const releaseDir = releaseFlag >= 0
    ? resolve(bundlesRoot, args[releaseFlag + 1])
    : latestReleaseDir();
  const outFlag = args.indexOf("--out");
  const outDir = outFlag >= 0
    ? resolve(args[outFlag + 1])
    : join(releaseDir, "update-source");
  const catalog = writeUpdateSource(releaseDir, outDir);
  console.log(`update-source: release ${catalog.releaseId}`);
  for (const [name, meta] of Object.entries(catalog.components)) {
    console.log(`  component ${name} -> ${meta.buildId}`);
  }
  for (const artifact of catalog.artifacts) {
    console.log(`  artifact ${artifact.id} (${artifact.restartPolicy}) -> ${artifact.payload.path}`);
  }
  console.log(`update-source ready: ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
