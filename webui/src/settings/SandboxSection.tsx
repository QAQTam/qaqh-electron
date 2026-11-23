/**
 * 「沙箱环境」面板：分组左文右控布局（开关 / 能力总览 / 可折叠探针与修复指引）。
 */
import { createMemo, createSignal, For, onCleanup, onSettled, Show, type Component } from "solid-js";
import IconChevronDown from "~icons/lucide/chevron-down";
import IconCopy from "~icons/lucide/copy";
import IconRefreshCw from "~icons/lucide/refresh-cw";
import {
  describePlatform,
  describeSandboxBackend,
  fetchSandboxPreflightStatus,
  parseRemediation,
  startSandboxPreflight,
  stepStatusLabel,
  type SandboxPreflightReport,
} from "../lib/sandbox-preflight";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { SettingGroup, SettingRow } from "../ui/SettingGroup";
import { toast } from "../ui/toast";
import { Switch } from "./controls";

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export const SandboxSection: Component<{
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}> = (props) => {
  const [report, setReport] = createSignal<SandboxPreflightReport | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [showSteps, setShowSteps] = createSignal(false);

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const stopPolling = (): void => {
    if (pollTimer != null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  onCleanup(() => {
    disposed = true;
    stopPolling();
  });

  const schedulePoll = (runId?: string): void => {
    stopPolling();
    pollTimer = setTimeout(() => {
      if (disposed) return;
      void fetchSandboxPreflightStatus(runId)
        .then((next) => {
          if (disposed) return;
          setReport(next);
          if (next.state === "running" || next.state === "idle") {
            schedulePoll(next.run_id);
          } else {
            setBusy(false);
          }
        })
        .catch((cause) => {
          if (disposed) return;
          setError(messageOf(cause));
          setBusy(false);
        });
    }, 140);
  };

  const loadStatus = async (): Promise<void> => {
    stopPolling();
    setError(null);
    setBusy(true);
    try {
      const current = await fetchSandboxPreflightStatus();
      if (disposed) return;
      setReport(current);
      if (current.state === "running" || current.state === "idle") {
        schedulePoll(current.run_id);
      } else {
        setBusy(false);
      }
    } catch (cause) {
      if (disposed) return;
      setError(messageOf(cause));
      setBusy(false);
    }
  };

  const rerun = async (): Promise<void> => {
    if (busy()) return;
    stopPolling();
    setError(null);
    setBusy(true);
    try {
      const started = await startSandboxPreflight(true);
      if (disposed) return;
      setReport(started);
      if (started.state === "running" || started.state === "idle") {
        schedulePoll(started.run_id);
      } else {
        setBusy(false);
      }
    } catch (cause) {
      if (disposed) return;
      setError(messageOf(cause));
      setBusy(false);
    }
  };

  onSettled(() => {
    void loadStatus();
  });

  const backendInfo = createMemo(() => {
    const r = report();
    if (r == null) return describeSandboxBackend("auto", false);
    return describeSandboxBackend(r.effective_backend, r.filesystem_write_enforced);
  });

  const totalDurationMs = createMemo(() => {
    const r = report();
    if (r == null) return null;
    if (r.finished_at_ms != null && r.started_at_ms > 0 && r.finished_at_ms >= r.started_at_ms) {
      return r.finished_at_ms - r.started_at_ms;
    }
    const sum = r.steps.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0);
    return sum > 0 ? sum : null;
  });

  const remediations = createMemo(() => {
    const r = report();
    if (r == null) return [];
    const seen = new Set<string>();
    const list: ReturnType<typeof parseRemediation>[] = [];
    for (const item of r.remediations) {
      if (!item || seen.has(item)) continue;
      seen.add(item);
      list.push(parseRemediation(item));
    }
    return list;
  });

  const copyCommand = async (cmd: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(cmd);
      toast("已复制命令", "ok");
    } catch (cause) {
      toast(`复制失败：${messageOf(cause)}`, "err");
    }
  };

  const statusTone = (): "ok" | "warn" | "err" | "neutral" => {
    if (!props.enabled) return "neutral";
    const t = backendInfo().tone;
    return t === "ok" || t === "warn" || t === "err" ? t : "neutral";
  };

  return (
    <div id="section-sandbox" style={{ display: "flex", "flex-direction": "column", gap: "24px" }}>
      <SettingGroup
        title="命令隔离"
        aside={report() != null ? <span class="settings-muted">{describePlatform(report()!.platform)}</span> : undefined}
      >
        <div class="ui-setting-row">
          <Switch
            label="启用命令沙箱"
            hint="在系统内核隔离内运行常规命令；不可用或关闭时回退人工审批"
            checked={props.enabled}
            onToggle={props.onToggle}
          />
        </div>
      </SettingGroup>

      <SettingGroup
        title="环境能力"
        aside={
          <Button size="sm" variant="ghost" disabled={busy()} onClick={() => void rerun()}>
            <IconRefreshCw class={{ "icon-spin": busy() }} />
            {busy() ? "检测中…" : "重新检测"}
          </Button>
        }
      >
        <SettingRow
          label={backendInfo().name}
          desc={!props.enabled ? "当前配置已关闭沙箱" : backendInfo().summary}
        >
          <Badge tone={statusTone()}>
            {!props.enabled ? "已关闭" : backendInfo().badge}
          </Badge>
        </SettingRow>

        <Show when={report() != null && report()!.state === "running"}>
          <div style={{ padding: "8px 16px" }}>
            <div class="sandbox-progress" role="progressbar" aria-valuenow={report()!.progress_percent} aria-valuemin={0} aria-valuemax={100}>
              <div class="sandbox-progress-fill" style={{ width: `${report()!.progress_percent}%` }} />
            </div>
          </div>
        </Show>

        <Show when={report()}>
          {(r) => (
            <>
              <SettingRow label="文件写隔离">
                <Badge tone={r().filesystem_write_enforced ? "ok" : "err"}>
                  {r().filesystem_write_enforced ? "已生效" : "未生效"}
                </Badge>
              </SettingRow>
              <SettingRow label="网络隔离">
                <Badge tone={r().network_isolation_enforced ? "ok" : "warn"}>
                  {r().network_isolation_enforced ? "已断网" : "审批兜底"}
                </Badge>
              </SettingRow>
              <SettingRow label="进程身份" desc={totalDurationMs() != null ? `检测耗时 ${totalDurationMs()} ms` : undefined}>
                <Badge tone={r().elevated ? "warn" : "ok"}>
                  {r().elevated ? "管理员提权" : "标准用户"}
                </Badge>
              </SettingRow>
            </>
          )}
        </Show>

        <Show when={error() != null}>
          <div style={{ padding: "10px 16px" }}>
            <p class="field-hint is-error" style={{ margin: 0 }}>获取沙箱状态失败：{error()}</p>
          </div>
        </Show>
      </SettingGroup>

      <Show when={remediations().length > 0}>
        <SettingGroup
          title="优化建议"
          aside={
            <Button size="sm" variant="ghost" disabled={busy()} onClick={() => void rerun()}>
              复检
            </Button>
          }
        >
          <For each={remediations()}>
            {(item) => (
              <div class="ui-setting-row" style={{ "flex-direction": "column", "align-items": "stretch", gap: "8px" }}>
                <span class="ui-setting-row-desc" style={{ color: "var(--text)" }}>{item.text}</span>
                <Show when={item.command != null}>
                  <div class="sandbox-cmd-row">
                    <code class="sandbox-cmd">{item.command}</code>
                    <Button size="sm" variant="secondary" onClick={() => void copyCommand(item.command!)}>
                      <IconCopy />
                      复制
                    </Button>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </SettingGroup>
      </Show>

      <Show when={report() != null && report()!.steps.length > 0}>
        <SettingGroup
          title="内核探针明细"
          aside={
            <Button size="sm" variant="ghost" onClick={() => setShowSteps((v) => !v)}>
              <span>
                {report()!.steps.filter((s) => s.status === "passed").length} / {report()!.steps.length} 通过
              </span>
              <IconChevronDown style={{ transform: showSteps() ? "rotate(180deg)" : "none", transition: "transform 140ms" }} />
            </Button>
          }
        >
          <Show
            when={showSteps()}
            fallback={
              <SettingRow label="自检项" desc="展开查看每项内核能力检测详情">
                <Badge tone="neutral">{report()!.steps.length} 项</Badge>
              </SettingRow>
            }
          >
            <For each={report()!.steps}>
              {(step) => (
                <SettingRow label={step.label} desc={step.detail}>
                  <Badge tone={step.status === "passed" ? "ok" : step.status === "failed" ? "err" : "warn"}>
                    {stepStatusLabel(step.status)}
                  </Badge>
                  <Show when={step.duration_ms != null}>
                    <span class="ui-setting-row-value is-mono">{step.duration_ms}ms</span>
                  </Show>
                </SettingRow>
              )}
            </For>
          </Show>
        </SettingGroup>
      </Show>
    </div>
  );
};
