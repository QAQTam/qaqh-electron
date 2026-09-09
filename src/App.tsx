// App：五区布局骨架 + 连接门控（spec §2 / §6）。
// 浏览器形态（无 bridge）走 mock 世界；Electron 形态走 lib/client.ts 真连接。
import { Errored, Show, createMemo, createSignal, onSettled } from "solid-js";
import type { Component } from "solid-js";
import type { AskQuestion, ToolPermissionRequest } from "qaqh-js-sdk";
import { TabStrip } from "./ui/TabStrip";
import { ContextBar } from "./ui/ContextBar";
import { Transcript } from "./ui/Transcript";
import Inspector from "./ui/Inspector";
import { Composer, type AttachmentChip, type ComposerActions } from "./ui/Composer";
import { ApprovalCard } from "./ui/ApprovalCard";
import { AskCard } from "./ui/AskCard";
import { PlanReviewCard } from "./ui/PlanReviewCard";
import { StatusLine } from "./ui/StatusLine";
import { CommandPalette } from "./ui/CommandPalette";
import { ToastStack, pushToast } from "./ui/Toast";
import { connectionStore } from "./state/connection";
import { tabsStore } from "./state/tabs";
import { useSession } from "./state/session";
import { MOCK_RAW_EVENTS } from "../dev/mocks/mockData";
import { mockSessionView } from "../dev/mocks/mockWorld";
import { bridge } from "./lib/bridge";
import { startClient, loadSession, refreshSessionList, sendCommand, uploadContent } from "./lib/client";

// 是否为 Electron 形态（有 bridge 走真连接）
const HAS_BRIDGE = Boolean(bridge());

interface GateView {
  title: string;
  sub?: string;
  error?: string;
  retry?: boolean;
}

const Gate: Component<{ view: GateView; onRetry?: () => void }> = (props) => (
  <div class="gate" style={{ display: props.view.title ? undefined : "none", flex: 1 }}>
    <div class="gate-title">{props.view.title}</div>
    <Show when={props.view.sub}>
      <div class="gate-sub">{props.view.sub}</div>
    </Show>
    <Show when={props.view.error}>
      <div class="gate-error">{props.view.error}</div>
    </Show>
    <Show when={props.view.retry && props.onRetry}>
      <button class="gate-btn" onClick={() => props.onRetry?.()}>
        重试
      </button>
    </Show>
  </div>
);

const App: Component = () => {
  const [inspectorOpen, setInspectorOpen] = createSignal(!HAS_BRIDGE); // 浏览器验收默认展开
  const [paletteOpen, setPaletteOpen] = createSignal(
    // dev 验收：?palette=1 直接打开命令面板
    typeof location !== "undefined" && new URLSearchParams(location.search).get("palette") === "1",
  );
  const [chips, setChips] = createSignal<AttachmentChip[]>([]);
  const [approvals, setApprovals] = createSignal<
    Array<{ req: ToolPermissionRequest; arrivedAt: number }>
  >([]);
  const [asks, setAsks] = createSignal<
    Array<{ interactionId: string; questions: AskQuestion[] }>
  >([]);
  const [plans, setPlans] = createSignal<
    Array<{ interactionId: string; content: string; todos: null }>
  >([]);

  const activeSeed = createMemo(() => tabsStore.activeSeed());
  const session = useSession(activeSeed);

  // mock 形态：projection 为空 → 直接读 mock view map
  const sessionView = createMemo(() => {
    if (HAS_BRIDGE) return session();
    const seed = activeSeed();
    return seed ? mockSessionView(seed) : null;
  });

  const turns = createMemo(() => sessionView()?.turns ?? []);
  const tab = createMemo(() => tabsStore.activeTab());
  const busy = createMemo(() => tab()?.activity === "working");
  const daemonDead = createMemo(
    () =>
      connectionStore.phase() === "daemonDead" || connectionStore.phase() === "daemonMissing",
  );

  // ── 启动序列（真形态）：连接 daemon → session.list → 激活首 tab ──
  onSettled(() => {
    if (!HAS_BRIDGE) return;
    void (async () => {
      try {
        await startClient();
      } catch (e) {
        const msg = String(e);
        if (msg.includes("binary not found") || msg.includes("not found")) {
          connectionStore.setDaemonMissing();
        } else {
          connectionStore.setFail(msg);
        }
      }
    })();
    // tab 激活 → 未装载则走装载序列
    const onActivate = (e: Event) => {
      const seed = (e as CustomEvent<string>).detail;
      const t = tabsStore.tab(seed);
      if (t && !t.hydrated) void loadSession(seed);
    };
    const onNewSession = () => {
      void sendCommand("control", {
        channel: "control",
        type: "session_create",
        close_current: false,
      }).then(() => void refreshSessionList());
    };
    window.addEventListener("qaqh:activateTab", onActivate);
    window.addEventListener("qaqh:newSession", onNewSession);
    return () => {
      window.removeEventListener("qaqh:activateTab", onActivate);
      window.removeEventListener("qaqh:newSession", onNewSession);
    };
  });

  // ── 全局键盘 ──
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setInspectorOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("qaqh:newSession"));
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        tabsStore.cycle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ── UI 动作接线（TabStrip/ContextBar → 自定义事件） ──
  onSettled(() => {
    const onActivate = (e: Event) => tabsStore.setActive((e as CustomEvent<string>).detail);
    const onArchive = (e: Event) => {
      const seed = (e as CustomEvent<string>).detail;
      tabsStore.remove(seed);
      pushToast("会话已归档");
    };
    const onCloseTab = (e: Event) => tabsStore.remove((e as CustomEvent<string>).detail);
    const onToast = (e: Event) => pushToast((e as CustomEvent<string>).detail);
    const onSetMode = (e: Event) => {
      const { seed, mode } = (e as CustomEvent<{ seed: string; mode: "plan" | "code" }>).detail;
      if (seed) tabsStore.patchMeta(seed, { mode });
      pushToast(`已切换到 ${mode.toUpperCase()} 模式`);
      if (HAS_BRIDGE && seed) {
        void sendCommand("conversation", { channel: "conversation", type: "conversation_set_mode", mode }, seed);
      }
    };
    window.addEventListener("qaqh:activateTab", onActivate);
    window.addEventListener("qaqh:archiveSession", onArchive);
    window.addEventListener("qaqh:closeSession", onCloseTab);
    window.addEventListener("qaqh:toast", onToast);
    window.addEventListener("qaqh:setMode", onSetMode);
    return () => {
      window.removeEventListener("qaqh:activateTab", onActivate);
      window.removeEventListener("qaqh:archiveSession", onArchive);
      window.removeEventListener("qaqh:closeSession", onCloseTab);
      window.removeEventListener("qaqh:toast", onToast);
      window.removeEventListener("qaqh:setMode", onSetMode);
    };
  });

  const composerActions: ComposerActions = {
    send: (text: string, attachments) => {
      const seed = activeSeed();
      if (!seed) return Promise.reject(new Error("no active session"));
      if (HAS_BRIDGE) {
        // 失败 reject → composer 保留内容 + 红边（spec §11）
        return sendCommand(
          "conversation",
          {
            channel: "conversation",
            type: "conversation_send_message",
            text,
            images: [],
            attachments: attachments.length ? attachments : null,
            as_system: false,
          },
          seed,
        ).then(() => undefined);
      }
      window.dispatchEvent(new CustomEvent("qaqh:send", { detail: { seed, text } }));
      return Promise.resolve();
    },
    cancel: () => {
      const seed = activeSeed();
      if (HAS_BRIDGE && seed) {
        void sendCommand("conversation", { channel: "conversation", type: "conversation_cancel" }, seed);
      }
      pushToast("已发送取消命令（等事件回执）");
    },
    setMode: (mode: "plan" | "code") => {
      window.dispatchEvent(
        new CustomEvent("qaqh:setMode", { detail: { seed: activeSeed(), mode } }),
      );
    },
    pickAttachments: () => {
      const b = bridge();
      if (!b) return;
      const seed = activeSeed();
      void b.pickAttachments({ multiple: true }).then(async (files) => {
        for (const f of files) {
          setChips((c) => [...c, { name: f.name, uploading: true }]);
          if (HAS_BRIDGE && seed) {
            try {
              const ref = await uploadContent(seed, f.bytes, f.mime, f.name);
              setChips((c) =>
                c.map((x) => (x.name === f.name ? { ...x, uploading: false, ref } : x)),
              );
            } catch {
              setChips((c) =>
                c.map((x) => (x.name === f.name ? { ...x, uploading: false, failed: true } : x)),
              );
            }
          } else {
            // mock：假引用
            setTimeout(() => {
              setChips((c) =>
                c.map((x) =>
                  x.name === f.name
                    ? {
                        ...x,
                        uploading: false,
                        ref: {
                          content_id: `mock-${f.name}`,
                          media_type: f.mime,
                          sha256: "mock",
                          truncated: false,
                        },
                      }
                    : x,
                ),
              );
            }, 800);
          }
        }
      });
    },
    removeAttachment: (name: string) => {
      setChips((c) => c.filter((x) => x.name !== name));
    },
  };

  const approvalActions = {
    respond: (callId: string, approved: boolean, trustFolder: boolean) => {
      pushToast(`审批已提交：${approved ? (trustFolder ? "信任此目录" : "允许一次") : "拒绝"}（mock）`);
      setApprovals((a) => a.filter((x) => x.req.toolCallId !== callId));
    },
  };

  const askActions = {
    respond: (interactionId: string, answers: Array<{ question_id: string; answer: string }>) => {
      pushToast(`已回答 ${answers.length} 个问题（mock）`);
      setAsks((a) => a.filter((x) => x.interactionId !== interactionId));
    },
    dismiss: (interactionId: string) => {
      setAsks((a) => a.filter((x) => x.interactionId !== interactionId));
    },
  };

  const planActions = {
    respond: (interactionId: string, approved: boolean) => {
      pushToast(approved ? "计划已通过（mock）" : "计划已驳回（mock）");
      setPlans((p) => p.filter((x) => x.interactionId !== interactionId));
    },
  };

  // ── 连接门控 ──
  const gate = createMemo<GateView | null>(() => {
    const p = connectionStore.phase();
    if (HAS_BRIDGE && p !== "ready") {
      if (p === "booting" || p === "connecting")
        return { title: "正在连接 daemon…", sub: "发现/拉起本地 daemon 并协商 lease" };
      if (p === "daemonMissing")
        return { title: "未找到 daemon 二进制", sub: "请先启动 qaqh-daemon 或填写二进制路径" };
      if (p === "daemonDead")
        return { title: "daemon 已退出", sub: "可点击重试重新拉起", retry: true };
      if (p === "reconnecting") return { title: "重连中…", sub: connectionStore.failDetail() };
      if (p === "failed")
        return {
          title: "连接失败",
          sub: connectionStore.failDetail(),
          error: connectionStore.failCount() >= 3 ? "已重试 3 次" : undefined,
          retry: true,
        };
    }
    return null;
  });

  // mock 静态审批卡（session A 的 pendingPermission）
  const mockApproval = createMemo<{ req: ToolPermissionRequest; arrivedAt: number } | null>(() => {
    if (HAS_BRIDGE) return null;
    const seed = activeSeed();
    const view = seed ? mockSessionView(seed) : null;
    const perm = view?.pendingPermissions[0]?.permission;
    return perm ? { req: perm, arrivedAt: Date.now() - 12_000 } : null;
  });

  return (
    <Errored
      fallback={(err) => (
        <Gate view={{ title: "界面异常", error: String(err()) }} />
      )}
    >
      <div class="shell">
        <TabStrip />
        <Show when={gate()}> {(g: () => GateView) => <Gate view={g()} onRetry={() => void startClient()} />}</Show>
        <div class="shell-body" style={{ display: gate() ? "none" : undefined }}>
            <div class="main-col">
              <ContextBar />
              <div class="transcript-region">
                <Transcript turns={turns()} />
                <Show when={inspectorOpen()}>
                  <Inspector session={sessionView()} rawEvents={MOCK_RAW_EVENTS} />
                </Show>
              </div>
              <Show when={mockApproval()}>
                {(a) => (
                  <div class="interaction-stack">
                    <ApprovalCard request={a().req} arrivedAt={a().arrivedAt} actions={approvalActions} />
                  </div>
                )}
              </Show>
              <Show when={HAS_BRIDGE && approvals().length > 0}>
                <div class="interaction-stack">
                  <ApprovalCard
                    request={approvals()[0]!.req}
                    arrivedAt={approvals()[0]!.arrivedAt}
                    actions={approvalActions}
                  />
                </div>
              </Show>
              <Show when={asks().length > 0}>
                <div class="interaction-stack">
                  <AskCard
                    interactionId={asks()[0]!.interactionId}
                    questions={asks()[0]!.questions}
                    actions={askActions}
                  />
                </div>
              </Show>
              <Show when={plans().length > 0}>
                <div class="interaction-stack">
                  <PlanReviewCard
                    interactionId={plans()[0]!.interactionId}
                    planContent={plans()[0]!.content}
                    todoItems={plans()[0]!.todos}
                    actions={planActions}
                  />
                </div>
              </Show>
              <div class="composer-zone">
                <Composer
                  mode={tab()?.meta.mode ?? "code"}
                  busy={busy()}
                  daemonDead={daemonDead()}
                  chips={chips()}
                  actions={composerActions}
                />
              </div>
            </div>
        </div>
        <StatusLine />
        <CommandPalette open={paletteOpen()} onClose={() => setPaletteOpen(false)} />
        <ToastStack />
      </div>
    </Errored>
  );
};

export default App;
