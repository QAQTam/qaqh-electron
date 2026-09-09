// StatusLine：20px mono（spec §9）。左：daemon 端点 · lease 剩余 · epoch；
// 右：N tabs · M 等待用户。断开态整条变红底。
import { Show, createMemo, createSignal, onSettled } from "solid-js";
import type { Component } from "solid-js";
import { connectionStore } from "../state/connection";
import { tabsStore } from "../state/tabs";

function short(s: string, n = 6): string {
  return s.length <= n ? s : s.slice(0, n);
}

export const StatusLine: Component = () => {
  const [nowTick, setNowTick] = createSignal(Date.now());

  onSettled(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  });

  const phase = createMemo(() => connectionStore.phase());
  const isError = createMemo(() => phase() === "failed" || phase() === "daemonDead" || phase() === "daemonMissing");
  const isBusy = createMemo(() => phase() === "connecting" || phase() === "reconnecting" || phase() === "booting");

  const leaseRemain = createMemo(() => {
    const info = connectionStore.info();
    if (!info) return null;
    // TTL 内倒计；归零后 lease 通常已被 SDK 静默续期（sid 不变），显示续期态
    const remain = info.leaseTtlMs - (nowTick() - info.leasedAt);
    return remain > 0 ? Math.floor(remain / 1000) : null;
  });
  const leaseRenewing = createMemo(() => {
    const info = connectionStore.info();
    if (!info) return false;
    return nowTick() - info.leasedAt >= info.leaseTtlMs;
  });

  const waitingCount = createMemo(
    () => tabsStore.order().filter((s) => tabsStore.tab(s)?.activity === "waiting_user").length,
  );
  const tabCount = createMemo(() => tabsStore.order().filter((s) => !tabsStore.tab(s)?.archived).length);

  return (
    <div class={["statusline", { error: isError(), connecting: isBusy() && !isError() }]}>
      <span class="st-dot" />
      <Show when={connectionStore.info()}>
        {(info) => (
          <>
            <span>{info().endpoint.replace(/^https?:\/\//, "")}</span>
            <Show when={leaseRemain() !== null}>
              <span class={leaseRemain() !== null && leaseRemain()! < 30 ? "st-warn" : ""}>
                lease {leaseRemain()}s
              </span>
            </Show>
            <Show when={leaseRenewing()}>
              <span>lease renew…</span>
            </Show>
            <span>epoch {short(info().serverEpoch.replace(/^epoch-/, ""), 8)}</span>
            <Show when={info().adopted}>
              <span title="复用既有 daemon">adopted</span>
            </Show>
          </>
        )}
      </Show>
      <Show when={phase() === "booting"}>
        <span>daemon 启动中…</span>
      </Show>
      <Show when={phase() === "connecting"}>
        <span>连接中…</span>
      </Show>
      <Show when={phase() === "reconnecting"}>
        <span class="st-warn">重连中…</span>
      </Show>
      <Show when={phase() === "daemonDead"}>
        <span>daemon 已退出</span>
      </Show>
      <Show when={phase() === "daemonMissing"}>
        <span>未找到 daemon 二进制</span>
      </Show>
      <Show when={connectionStore.failDetail()}>
        <span style={{ color: "var(--danger)" }}>{connectionStore.failDetail()}</span>
      </Show>
      <Show when={connectionStore.recoveredNote()}>
        <span style={{ color: "var(--ok)" }}>会话已恢复</span>
      </Show>
      <span class="st-right">
        {tabCount()} tabs
        <Show when={waitingCount() > 0}> · <span class="st-warn">{waitingCount()} 等待用户</span></Show>
      </span>
    </div>
  );
};
