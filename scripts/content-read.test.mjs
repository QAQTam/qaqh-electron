import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHost, mockSdk } from "./test-host.mjs";

test("正文读取经固定 IPC 调用 SDK，并正确解码中文 UTF-8", async () => {
  const { sdk } = mockSdk();
  const calls = [];
  sdk.downloadContent = async ref => {
    calls.push(ref);
    return { bytes: new TextEncoder().encode("你好！我是 QAQ。") };
  };
  const host = await loadHost({ sdk });
  const client = new host.RingingClient(() => {});
  host.registerIpcHandlers(client, {}, new host.ChallengeManager());
  const ref = `sha256:${"a".repeat(64)}`;
  assert.equal(await host.invoke("content_read_text", { contentRef: ref, requestId: "a".repeat(32) }), "你好！我是 QAQ。");
  assert.deepEqual(calls, [ref]);
  for (const value of [null, "../config", "sha256:bad", "http://localhost", 42]) {
    await assert.rejects(host.invoke("content_read_text", { contentRef: value }), /invalid content_ref/);
  }
  assert.equal(calls.length, 1);
  sdk.downloadContent = async () => { throw new Error("content not found"); };
  await assert.rejects(host.invoke("content_read_text", { contentRef: ref }), /content not found/);
});
