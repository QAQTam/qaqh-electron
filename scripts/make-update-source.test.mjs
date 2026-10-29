import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalog, validateCatalogShape, writeUpdateSource } from "./make-update-source.mjs";

function writeManifest(releaseDir, kind, buildId, version = "2.0.0", protocol = 1) {
  const dir = join(releaseDir, buildId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "bundle.json"), `${JSON.stringify({
    formatVersion: 1,
    kind,
    buildId,
    appVersion: version,
    releaseId: "rel-1",
    channel: "local",
    components: { [kind]: { buildId, version, controlProtocol: protocol } },
    requiresFullInstall: false,
    files: [{ source: `files/x`, target: "x", size: 1, sha256: "a".repeat(64) }],
  }, null, 2)}\n`);
}

function fixture(tag) {
  const root = mkdtempSync(join(tmpdir(), `qaqh-update-source-${tag}-`));
  const releaseDir = join(root, "rel-1");
  mkdirSync(join(releaseDir, "bundles"), { recursive: true });
  writeManifest(releaseDir, "frontend", "frontend-f1");
  writeManifest(releaseDir, "backend", "backend-b1");
  const zips = {
    "frontend-f1.zip": Buffer.from("fake-zip-frontend"),
    "backend-b1.zip": Buffer.from("fake-zip-backend"),
  };
  for (const [name, content] of Object.entries(zips)) {
    writeFileSync(join(releaseDir, "bundles", name), content);
  }
  return { root, releaseDir, zips };
}

describe("make-update-source", () => {
  it("catalog 与 model.rs::Catalog 同形:组件合并/artifact 指向 bundle zip", () => {
    const { root, releaseDir, zips } = fixture("shape");
    try {
      const catalog = buildCatalog(releaseDir, { publishedAt: "2026-10-28T00:00:00Z" });
      assert.equal(catalog.formatVersion, 1);
      assert.equal(catalog.releaseId, "rel-1");
      assert.equal(catalog.channel, "local");
      assert.deepEqual(Object.keys(catalog.components).sort(), ["backend", "frontend"]);
      assert.equal(catalog.components.frontend.buildId, "frontend-f1");
      assert.equal(catalog.components.frontend.controlProtocol, 1);

      const frontend = catalog.artifacts.find((a) => a.id === "frontend");
      const backend = catalog.artifacts.find((a) => a.id === "backend");
      assert.equal(frontend.strategy, "component-full");
      assert.equal(frontend.restartPolicy, "electron");
      assert.equal(backend.restartPolicy, "daemon");
      assert.deepEqual(frontend.targets, { frontend: "frontend-f1" });
      // payload 摘要与 zip 实际字节一致
      assert.equal(
        frontend.payload.sha256,
        createHash("sha256").update(zips["frontend-f1.zip"]).digest("hex"),
      );
      assert.equal(frontend.payload.path, "bundles/frontend-f1.zip");
      validateCatalogShape(catalog);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeUpdateSource 产出 bundles/ + catalog.json,且拷贝字节一致", () => {
    const { root, releaseDir, zips } = fixture("write");
    try {
      const out = join(root, "update-source");
      const catalog = writeUpdateSource(releaseDir, out);
      assert.ok(existsSync(join(out, "catalog.json")));
      const onDisk = JSON.parse(readFileSync(join(out, "catalog.json"), "utf8"));
      assert.deepEqual(onDisk, { ...catalog, publishedAt: onDisk.publishedAt });
      assert.equal(
        readFileSync(join(out, "bundles/frontend-f1.zip")).toString(),
        zips["frontend-f1.zip"].toString(),
      );
      assert.equal(
        readFileSync(join(out, "bundles/backend-b1.zip")).toString(),
        zips["backend-b1.zip"].toString(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("缺 zip / targets 与 components 不一致时报错", () => {
    const { root, releaseDir } = fixture("errors");
    try {
      rmSync(join(releaseDir, "bundles/frontend-f1.zip"));
      assert.throws(() => buildCatalog(releaseDir), /missing zip/);
      writeFileSync(join(releaseDir, "bundles/frontend-f1.zip"), Buffer.from("back"));
      const catalog = buildCatalog(releaseDir);
      catalog.components.frontend.buildId = "drifted";
      assert.throws(() => validateCatalogShape(catalog), /不一致/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
