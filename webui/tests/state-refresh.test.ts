import { afterEach, expect, test, vi } from "vitest";
import { loadConfigSnapshot, invalidateConfigSnapshot } from "../src/lib/config-snapshot";
import { notifyConfigChanged } from "../src/lib/config-events";
import { transport } from "../src/lib/transport";
import { pollSessions, refreshWorkspaces, registerWorkspace, workspaceCatalog } from "../src/tabs/store";
import { refreshRegistry } from "../src/settings/registry";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.restoreAllMocks(); invalidateConfigSnapshot(); });

test("并发读取配置合并，广播后旧请求不能覆盖新配置", async () => {
  const old = deferred<any>();
  const fresh = deferred<any>();
  const query = vi.spyOn(transport, "query").mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
  const first = loadConfigSnapshot();
  const second = loadConfigSnapshot();
  expect(query).toHaveBeenCalledTimes(1);
  notifyConfigChanged();
  const third = loadConfigSnapshot();
  fresh.resolve({ contextLength: 42 });
  old.resolve({ contextLength: 1 });
  expect(await Promise.all([first, second, third])).toEqual(Array(3).fill({ contextLength: 42 }));
  expect(query).toHaveBeenCalledTimes(2);
});

test("并发目录刷新共享 provider 请求（profile.list 已随 B06 退出刷新链）", async () => {
  const provider = deferred<any>();
  const command = vi.spyOn(transport, "command").mockImplementation(() => provider.promise);
  const query = vi.spyOn(transport, "query");
  const reads = [refreshRegistry(), refreshRegistry()];
  expect(command).toHaveBeenCalledTimes(1);
  expect(query).not.toHaveBeenCalled();
  provider.resolve({ status: "accepted", result: { providers: {}, revision: 0 } });
  await Promise.all(reads);
});

test("会话轮询不读取工作区，创建工作区后更新列表", async () => {
  const sessions = vi.spyOn(transport, "sessions").mockResolvedValue([]);
  const entry = { id: "w1", path: "/tmp/a", title: "a", order: 0, missing_dir: false };
  const query = vi.spyOn(transport, "query").mockResolvedValue([entry] as never);
  vi.spyOn(transport, "command").mockResolvedValue({ status: "accepted", result: entry } as never);
  await pollSessions();
  expect(sessions).toHaveBeenCalledTimes(1);
  expect(query).not.toHaveBeenCalled();
  await registerWorkspace(entry.path);
  expect(query).toHaveBeenCalledTimes(1);
  expect(workspaceCatalog()).toEqual([entry]);
  await refreshWorkspaces();
  expect(query).toHaveBeenCalledTimes(2);
});

test("目录刷新跨写入通知时丢弃旧结果", async () => {
  const staleProvider = deferred<any>();
  const providerCommand = vi.spyOn(transport, "command")
    .mockImplementationOnce(() => staleProvider.promise)
    .mockResolvedValue({ status: "accepted", result: { providers: {}, revision: 2 } } as never);
  const query = vi.spyOn(transport, "query");
  const old = refreshRegistry();
  notifyConfigChanged();
  const fresh = refreshRegistry();
  await fresh;
  staleProvider.resolve({ status: "accepted", result: { providers: {}, revision: 1 } });
  await old;
  const { registry } = await import("../src/settings/registry");
  expect(registry()?.revision).toBe(2);
  expect(providerCommand).toHaveBeenCalledTimes(3);
  expect(query).not.toHaveBeenCalled();
});
