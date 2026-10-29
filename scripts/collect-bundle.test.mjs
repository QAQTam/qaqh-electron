import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBundleManifest, collectBundle } from "./collect-bundle.mjs";

function makeSource(tag) {
  const root = mkdtempSync(join(tmpdir(), `qaqh-collect-${tag}-`));
  mkdirSync(join(root, "dist", "main"), { recursive: true });
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "dist", "main", "index.cjs"), "console.log(1)\n");
  return root;
}

const baseOptions = {
  kind: "frontend", buildId: "abc123", appVersion: "2.0.1", source: "",
  targetPrefix: "app", out: "", exec: [], components: [], componentVersions: [],
  controlProtocol: 1, releaseId: "r1", channel: "local",
};

describe("collect-bundle", () => {
  it("manifest 与 model.rs::BundleManifest 同形,可执行文件带 0o755", async () => {
    const source = makeSource("manifest");
    const out = mkdtempSync(join(tmpdir(), "qaqh-collect-out-"));
    try {
      const manifest = await collectBundle([
        "--kind", "frontend", "--build-id", "abc123", "--app-version", "2.0.1",
        "--source", source, "--target-prefix", "app", "--out", out,
        "--control-protocol", "1", "--release-id", "r1", "--channel", "local",
        "--exec", "dist/main/index.cjs",
      ]);
      assert.equal(manifest.formatVersion, 1);
      assert.equal(manifest.requiresFullInstall, false);
      assert.deepEqual(Object.keys(manifest.components), ["frontend"]);
      assert.equal(manifest.components.frontend.controlProtocol, 1);
      const main = manifest.files.find((file) => file.target === "app/dist/main/index.cjs");
      const pkg = manifest.files.find((file) => file.target === "app/package.json");
      assert.equal(main.mode, 0o755);
      assert.equal(pkg.mode, undefined); // 无执行位 → 字段省略(camelCase JSON 与 crate 对齐)
      // files/ 物化与清单字节一致
      assert.equal(statSync(join(out, "files/app/dist/main/index.cjs")).size, main.size);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("--component/--component-version 显式指定组件表", () => {
    const manifest = buildBundleManifest(
      { ...baseOptions, kind: "full", components: ["frontend=fx1", "backend=bx1"], componentVersions: ["backend=9.9.9"] },
      [{ source: "files/x", target: "x", size: 1, sha256: "0".repeat(64) }],
    );
    assert.equal(manifest.requiresFullInstall, true);
    assert.deepEqual(manifest.components.frontend, { buildId: "fx1", version: "2.0.1", controlProtocol: 1 });
    assert.deepEqual(manifest.components.backend, { buildId: "bx1", version: "9.9.9", controlProtocol: 1 });
  });

  it("路径逃逸与空目录被拒绝", async () => {
    const source = makeSource("escape");
    const out = mkdtempSync(join(tmpdir(), "qaqh-collect-out-"));
    try {
      await assert.rejects(
        () => collectBundle(["--kind", "frontend", "--build-id", "x", "--app-version", "1",
          "--source", source, "--target-prefix", "../evil", "--out", out]),
        /unsupported bundle kind|unknown flag|path escapes|missing value/,
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("source 为空目录时报错而非产出坏 manifest", async () => {
    const source = mkdtempSync(join(tmpdir(), "qaqh-collect-empty-"));
    const out = mkdtempSync(join(tmpdir(), "qaqh-collect-out-"));
    try {
      await assert.rejects(
        () => collectBundle(["--kind", "frontend", "--build-id", "x", "--app-version", "1",
          "--source", source, "--target-prefix", "app", "--out", out]),
        /contains no files/,
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("--exec 强制可执行位", async () => {
    const source = makeSource("force-exec");
    chmodSync(join(source, "dist", "main", "index.cjs"), 0o644);
    const out = mkdtempSync(join(tmpdir(), "qaqh-collect-out-"));
    try {
      const manifest = await collectBundle([
        "--kind", "frontend", "--build-id", "x", "--app-version", "1",
        "--source", source, "--target-prefix", "app", "--out", out,
        "--exec", "dist/main/index.cjs",
      ]);
      const main = manifest.files.find((file) => file.target === "app/dist/main/index.cjs");
      assert.equal(main.mode, 0o755);
    } finally {
      rmSync(source, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
