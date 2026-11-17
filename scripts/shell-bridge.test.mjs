// 用户 shell 数据面桥的验收(ADR-0028 切片 5:后端 PTY + Ringing ws)。
//
// Rust 侧的读循环(帧编解码、`from_offset` 续读、退避重连)有自己的定向测试
// (`cargo test -p qaqh-client --features shell-stream`,含真 socket 上的重连)。
// TS 这层只需要钉住三件容易在后续改动里坏掉的事:
//   1. 桥**只**承载这条流;生命周期三条(`shell.open/close/list`)走通用 service_query,
//      不包第二层(包了就出现「同一个动作两个入口」);
//   2. 渲染层看得见两种事实(裸字节 / 协议 closed),看不见第三种(断线不是结束,§D5);
//   3. 上行 stdin 交出去的是 UTF-8 字节,base64/JSON 帧形状不在 TS 里。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadHost, mockNativeAddon } from "./test-host.mjs";

const shellView = {
  id: "sh1", pid: 4242, shell: "powershell.exe", cwd: "D:/x",
  cols: 100, rows: 24, alive: true, output_offset: 0,
};

async function bridge() {
  const mock = mockNativeAddon();
  const rpc = [];
  mock.client.serviceCall = async (method, params) => {
    rpc.push([method, params]);
    if (method === "shell.open") return shellView;
    if (method === "shell.list") return { shells: [shellView] };
    return { shell_id: params.shell_id, reason: "closed" };
  };
  const events = [];
  const host = await loadHost({ native: mock.addon });
  const client = new host.RingingClient({}, (name, payload) => events.push([name, payload]));
  host.registerIpcHandlers(client, {}, new host.ChallengeManager());
  return { host, mock, rpc, events };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("the shell bridge carries the stream only; lifecycle stays on the service surface", async () => {
  const { host, mock, rpc } = await bridge();

  // 生命周期 = 通用 service_query(渲染层唯一的一条 RPC 路)。
  await host.invoke("service_query", { method: "shell.open", params: { cols: 100, rows: 24, cwd: "D:/x" } });
  assert.deepEqual(rpc.at(-1), ["shell.open", { cols: 100, rows: 24, cwd: "D:/x" }]);
  await host.invoke("service_query", { method: "shell.list", params: {} });
  assert.deepEqual(rpc.at(-1), ["shell.list", {}]);
  assert.equal(mock.shellCalls.length, 0, "service_query 不该顺手订阅——那是桥的另一件事");

  // 字节面 = 桥的四条。
  await host.invoke("shell_attach", { shell_id: "sh1" });
  assert.deepEqual(mock.shellCalls.at(-1), ["subscribe", "sh1"]);
  await host.invoke("shell_detach", { shell_id: "sh1" });
  assert.deepEqual(mock.shellCalls.at(-1), ["close", "sh1"]);

  // 桥不暴露生命周期方法:主进程里没有第二条 open 路。
  assert.equal(typeof mock.client.shellOpen, "undefined");
  assert.deepEqual(host.MAIN_SERVICE_METHODS.filter(m => m.startsWith("shell.")).sort(),
    ["shell.close", "shell.list", "shell.open"]);
});

test("downlink bytes are verbatim; only the protocol frame says a shell ended", async () => {
  const { host, mock, events } = await bridge();
  await host.invoke("shell_attach", { shell_id: "sh1" });

  const prompt = new TextEncoder().encode("PS D:/x> ");
  mock.emit.shellFrame(prompt);
  assert.equal(events[0][0], "app://shell-frame");
  assert.equal(events[0][1].id, "sh1");
  assert.ok(events[0][1].data instanceof Uint8Array, "PTY 输出必须是裸字节,不是字符串/JSON");
  assert.deepEqual(Array.from(events[0][1].data), Array.from(prompt));
  assert.equal(events[0][1].closed, undefined);

  // 断线重连:传输事实只进日志。推成 `closed` 就是谎报(§D5 断联不 kill)。
  mock.emit.shellStatus({ shell_id: "sh1", state: "reconnecting", retry_ms: 1000, delivered: 9, reason: "连接中断" });
  assert.equal(events.length, 1, "reconnecting 不得伪装成结束");

  // 协议事实:词表里唯一一种下行 text 帧,reason 原样带过去(daemon 的 ShellStopReason)。
  mock.emit.shellEvent("sh1", { type: "closed", reason: "child_exited" });
  assert.deepEqual(events[1], ["app://shell-frame", { id: "sh1", closed: { reason: "child_exited" } }]);

  // 流终止(status closed,例如重连时 404 shell_not_found):收句柄,但不再推协议帧。
  mock.emit.shellStatus({ shell_id: "sh1", state: "closed", reason: "shell_not_found" });
  await tick();
  assert.ok(mock.shellCalls.some(call => call[0] === "close" && call[1] === "sh1"),
    "读循环已终止,句柄必须被收掉");
  assert.equal(events.length, 2, "传输层的 closed 不是第二个版本的「结束了」");
});

test("stdin goes out as UTF-8 bytes; ids and geometry are validated in main", async () => {
  const { host, mock } = await bridge();
  await host.invoke("shell_attach", { shell_id: "sh1" });

  await host.invoke("shell_stdin", { shell_id: "sh1", data: "dir\r" });
  assert.deepEqual(mock.shellCalls.at(-1), ["stdin", "sh1", new Uint8Array([0x64, 0x69, 0x72, 0x0d])]);

  await host.invoke("shell_resize", { shell_id: "sh1", cols: 132, rows: 44 });
  assert.deepEqual(mock.shellCalls.at(-1), ["resize", "sh1", 132, 44]);

  // 空/非字符串的 shell_id 与非整数几何必须是错误,不能静默变成一个无效调用。
  await assert.rejects(host.invoke("shell_stdin", { shell_id: "", data: "x" }), /shell_id/);
  await assert.rejects(host.invoke("shell_stdin", { shell_id: "sh1", data: 42 }), /string/);
  await assert.rejects(host.invoke("shell_resize", { shell_id: "sh1", cols: 100.5, rows: 24 }), /integer/);
  await assert.rejects(host.invoke("shell_resize", { shell_id: "sh1", cols: "80", rows: 24 }), /integer/);
});
