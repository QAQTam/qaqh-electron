// 连接单例 + 事件接线（spec §6.1/§6.4/§6.5/§7/§8）。
// renderer 一切协议流量经 QaqhClient；零手写 fetch/URL/SSE。
import type {
  RingingEventBatch,
  RingingCommand,
  RingingChannel,
  ResetSignal,
  ConnState,
  ConnInfo,
} from "qaqh-js-sdk";
import { QaqhClient, staticProvider, type SessionView } from "qaqh-js-sdk";
import { bridge } from "./bridge";
import { connectionStore } from "../state/connection";
import { tabsStore, type TabActivity } from "../state/tabs";
import { projection, bumpRev } from "../state/session";
import { pushToast } from "../ui/Toast";

export interface LoadedSession {
  turns: SessionView["turns"];
}

let client: QaqhClient | null = null;

/** 未知 seed → 建懒 tab（未激活不装载）。 */
function ensureTracked(seed: string): void {
  tabsStore.ensureTracked(seed);
}

/** 事件分发器：整 batch 传递；seed 集合先建 tab 再 applyBatch。 */
function dispatchBatch(batch: RingingEventBatch): void {
  const seeds = new Set(batch.envelopes.map((e) => e.seed).filter(Boolean));
  for (const s of seeds) ensureTracked(s);
  projection.applyBatch(batch);
  bumpRev();
  // activity/pendingCount 汇总到 tab
  for (const s of seeds) {
    const view = projection.getSnapshot().sessions.get(s);
    if (view) {
      tabsStore.refreshActivityFrom(
        {
          activity: (view.activity as TabActivity) ?? undefined,
          pendingCount: view.pendingPermissions.length,
        },
        s,
      );
    }
  }
}

/** 重置与恢复矩阵（spec §7）。 */
function handleReset(signal: ResetSignal): void {
  if (signal.seed && signal.channel) {
    // 单 tab 单频道精准重建：re-attach → bootstrap → 投影重建
    void (async () => {
      try {
        const seed = signal.seed!;
        await client!.attachSession(seed);
        const boot = await client!.bootstrap(seed);
        projection.hydrateBootstrap(seed);
        const page = await client!.timelineSnapshot(seed, {});
        projection.hydrateTimeline(seed, page.snapshot);
        bumpRev();
        const tab = tabsStore.tab(seed);
        if (tab) tabsStore.patch(seed, { hydrated: true });
        void boot;
      } catch (e) {
        pushToast(`频道重建失败：${String(e)}`, true);
      }
    })();
  } else {
    // epoch 级全量重建
    fullReload("会话已恢复");
  }
}

function onConnState(state: ConnState, info?: ConnInfo): void {
  if (state === "ready" && info) {
    connectionStore.setInfo({
      endpoint: currentEndpoint,
      serverEpoch: info.serverEpoch,
      leaseTtlMs: info.leaseTtlMs,
      leasedAt: Date.now(),
      adopted: currentAdopted,
    });
  } else if (state === "reconnecting") {
    connectionStore.setPhase("reconnecting");
  } else if (state === "closed") {
    connectionStore.setFail("连接已关闭");
  }
}

let currentEndpoint = "";
let currentAdopted = false;

/** 装载序列（tab 激活时一次，spec §6.5）：attach → bootstrap → timeline → subscribe。 */
const subscribed = new Set<string>();

export async function loadSession(seed: string): Promise<void> {
  if (!client) return;
  try {
    if (!subscribed.has(seed)) {
      await client.attachSession(seed);
      tabsStore.patch(seed, { attached: true });
      const boot = await client.bootstrap(seed);
      projection.hydrateBootstrap(seed);
      void boot;
      const page = await client.timelineSnapshot(seed, {});
      projection.hydrateTimeline(seed, page.snapshot);
      bumpRev();
      client.subscribeTimeline(seed, (msg) => {
        // timeline 增量轮次流（SseMessage.data 为 TimelineEvent JSON）
        try {
          const ev = JSON.parse(msg.data ?? "{}");
          projection.applyBatch({
            schema: "qaqh.Ringing",
            version: 1,
            channel: "conversation",
            seed,
            server_epoch: currentEpoch(),
            from_stream_seq: 0,
            to_stream_seq: 0,
            envelopes: [
              {
                delivery: "reliable",
                seed,
                stream_seq: 0,
                channel_seq: 0,
                session_seq: 0,
                event_id: `tl-${Date.now()}-${Math.random()}`,
                causation_id: null,
                correlation_id: null,
                event: { channel: "conversation", ...(ev as object) },
              } as never,
            ],
          });
        } catch {
          /* 增量帧解析失败交由 reset 机制兜底 */
        }
      });
      subscribed.add(seed);
      tabsStore.patch(seed, { hydrated: true });
    }
  } catch (e) {
    pushToast(`会话装载失败：${String(e)}`, true);
    tabsStore.patch(seed, { activity: "disconnected" });
  }
}

function currentEpoch(): string {
  return client?.info?.serverEpoch ?? "";
}

/** 全量恢复：清 projection、全部 tab 置未装载、重放激活 tab 装载序列。 */
async function fullReload(note?: string): Promise<void> {
  subscribed.clear();
  for (const seed of tabsStore.order()) {
    tabsStore.patch(seed, { hydrated: false });
  }
  const active = tabsStore.activeSeed();
  if (active) await loadSession(active);
  connectionStore.markRecovered();
  if (note) pushToast(note);
}

/** 启动序列（spec §6.1）。 */
export async function startClient(): Promise<void> {
  const b = bridge();
  if (!b) throw new Error("bridge unavailable");
  connectionStore.setPhase("connecting");
  const cfg = await b.getConnectionConfig();
  currentEndpoint = cfg.endpoint;
  currentAdopted = cfg.adopted;

  client = await QaqhClient.connect({
    provider: staticProvider({ endpoint: cfg.endpoint, token: cfg.token }, "shell"),
    clientInstanceId: cfg.clientInstanceId,
    onBatch: dispatchBatch,
    onReset: handleReset,
    onState: onConnState,
    onParseError: (err, ch, raw) =>
      console.warn("[ringing] parse", ch, err, raw.slice(0, 200)),
  });

  // bridge 事件
  b.onDaemonDied(() => {
    connectionStore.setDaemonDead();
    for (const seed of tabsStore.order()) {
      tabsStore.patch(seed, { activity: "disconnected" });
    }
  });
  b.onConfigChanged(() => {
    void fullReload("daemon 配置已更新");
  });

  // 首屏：session.list 灌标签 + 激活第一个
  await refreshSessionList();
  const first = tabsStore.order()[0];
  if (first) {
    tabsStore.setActive(first);
    await loadSession(first);
  }
}

/** session.list 富元数据 → TabsStore（archived / ephemeral 过滤）。 */
export async function refreshSessionList(): Promise<void> {
  if (!client) return;
  try {
    const list = await client.service("session.list");
    const arr = Array.isArray(list) ? list : [];
    tabsStore.ingestList(
      arr
        .filter((it) => {
          const rec = it as Record<string, unknown>;
          return rec.ephemeral !== true;
        })
        .map((it) => {
          const rec = it as Record<string, unknown>;
          return {
            seed: String(rec.seed),
            title: (rec.title as string | null) ?? null,
            cwd: (rec.cwd as string | null) ?? null,
            model: rec.model as string | undefined,
            mode: rec.mode as number | undefined,
            archived: rec.archived === true,
            last_summary: rec.last_summary as string | undefined,
          };
        }),
    );
  } catch (e) {
    pushToast(`session.list 失败：${String(e)}`, true);
  }
}

/** 命令发送（spec §8）：ack 只做 toast；终态等事件驱动渲染。 */
export async function sendCommand(
  channel: RingingChannel,
  command: RingingCommand,
  seed?: string,
): Promise<void> {
  if (!client) return;
  try {
    const ack = await client.sendCommand(channel, command, { seed });
    if (ack.status === "rejected") {
      pushToast(`命令被拒绝：${ack.code ?? ""} ${ack.message ?? ""}`, true);
    }
  } catch (e) {
    pushToast(`命令发送失败：${String(e)}`, true);
    throw e;
  }
}

/** 附件上传：Blob → ContentRef（禁传本地路径）。 */
export async function uploadContent(
  seed: string,
  bytes: ArrayBuffer,
  mime: string,
  name: string,
): Promise<{ content_id: string; media_type: string; sha256: string; truncated: boolean }> {
  if (!client) throw new Error("client unavailable");
  const blob = new Blob([bytes], { type: mime });
  return client.uploadContent(seed, blob, mime, name);
}

export function getClient(): QaqhClient | null {
  return client;
}
