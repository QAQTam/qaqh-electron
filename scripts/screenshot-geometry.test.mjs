import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["src/main/screenshot-geometry.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { selectionCrop } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);

test("maps a selection on a negative-origin scaled display", () => {
  assert.deepEqual(selectionCrop({ x: -900, y: 20, width: 200, height: 100 },
    { x: -1000, y: 0, width: 1000, height: 800 }, { width: 2000, height: 1600 }),
  { x: 200, y: 40, width: 400, height: 200 });
});

test("clips a selection across independently scaled displays", () => {
  const selection = { x: -100, y: 0, width: 200, height: 100 };
  assert.deepEqual(selectionCrop(selection, { x: -1000, y: 0, width: 1000, height: 800 }, { width: 2000, height: 1600 }),
    { x: 1800, y: 0, width: 200, height: 200 });
  assert.deepEqual(selectionCrop(selection, { x: 0, y: 0, width: 800, height: 600 }, { width: 800, height: 600 }),
    { x: 0, y: 0, width: 100, height: 100 });
});

test("rounds outward for fractional capture scaling and rejects empty intersections", () => {
  const display = { x: 0, y: 0, width: 100, height: 100 };
  assert.deepEqual(selectionCrop({ x: 1, y: 1, width: 1, height: 1 }, display, { width: 125, height: 125 }),
    { x: 1, y: 1, width: 2, height: 2 });
  assert.equal(selectionCrop({ x: 100, y: 0, width: 1, height: 1 }, display, { width: 125, height: 125 }), null);
});

test("rejects invalid, zero-sized and non-finite geometry", () => {
  const display = { x: 0, y: 0, width: 100, height: 100 };
  for (const selection of [{ x: 0, y: 0, width: 0, height: 1 }, { x: NaN, y: 0, width: 1, height: 1 }]) {
    assert.throws(() => selectionCrop(selection, display, { width: 100, height: 100 }), /Invalid screenshot geometry/);
  }
  assert.throws(() => selectionCrop(display, display, { width: 1.5, height: 100 }), /Invalid screenshot geometry/);
});
