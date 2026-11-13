# slot: overlay（跑 JS 的覆盖层）

```jsonc
{ "slot": "overlay", "entry": "dist/entry.js", "capabilities": ["gamepad-raw"] }
```

参考件：`plugins/qaqh-snake`（Canvas 游戏）、`plugins/qaqh-padview`（SVG 手柄映射图）。

## 模块形状

入口必须是 **ESM**，default 导出：

```ts
export default {
  mount(container: HTMLElement, host: PluginHost): void | (() => void) { /* … */ },
};
```

缺 `default.mount` → 装载器抛「插件 `<id>` 缺少 default.mount」，容器被移除并记入 `failed`。

## 宿主容器

装载器建 `div[data-qaqh-plugin=<id>]` append 到 `document.body`，样式固定为
`position:fixed; inset:0; pointer-events:none; z-index:2147483000`。

- 可交互元素必须自己写 `pointer-events:auto`，否则点不动（容器整体穿透）。
- 层级与内部布局插件自管，不要改容器的 `position/inset`。
- UI 全部挂进 `container`：dispose 时容器整体移除，挂在 body 别处的节点会泄漏。

## host facade（按 capabilities 白名单发放）

现有两个能力，都按 manifest 声明发放：

### `gamepad-raw` → `host.gamepadRaw(onFrame: (pad: Gamepad | null) => void): () => void`

- 实现在 `webui/src/lib/gamepad.ts` `startGamepadRawFeed`：rAF 循环，取第一个 connected 手柄，无手柄给 `null`。
- 未声明该 capability 时 `host` 是空对象，`host.gamepadRaw` 为 `undefined`——用 `?.` 调用并保留键盘兜底
  （两个样例都这么做，无手柄也能用）。
- 返回的 unsubscribe 必须在 dispose 里调用。
- 要新增能力：同时改 `loader.ts` 的 `PluginHost` 与 `facadeFor`，不要在插件里直接 import 宿主内部模块。

### `git-status` → `host.gitStatus(): Promise<GitStatusView>`

- 活动会话工作区的**只读** git 状态：`kind: "repo"` 时带 branch/head/upstream/ahead/behind/
  staged/unstaged/untracked/files/unpushed；另有 `no-workspace` / `not-repo` / `error` 三态。
- cwd 由 main 解析（`client.getActiveSeed()` → daemon `workspace.get`），插件不需要知道会话注册表；
  git 子进程只在 main 跑（`src/main/git-status.ts`，固定 argv、无 shell、8s 超时）。
- `ahead`/`behind` 为 `null` = 没有上游，**不是 0**；别把 null 当干净渲染。
- 线形契约在 `webui/src/lib/git-status.ts`（纯类型）。插件可以 `import type` 复用它——
  类型导入会被构建擦除，不构成对宿主运行时模块的依赖。
- 参考件 `plugins/qaqh-git`：轮询开合双档（展开 4s / 收起 15s）+ window focus 触发，
  dispose 清定时器与监听。

## dispose 纪律（热更与禁用都走它）

必须清掉：定时器/rAF、所有 `addEventListener`、注入的 `<style>`、容器内 DOM、facade 订阅。
`plugins/qaqh-snake/src/entry.ts` 的收尾：

```ts
return () => {
  stopTick();
  gamepadUnsub?.();
  document.removeEventListener("keydown", onKeyDown);
  style.remove();
  container.textContent = "";
};
```

漏一项 = 每次热更叠一层幽灵 UI 或监听。

## 依赖与构建

- 纯 DOM/Canvas/SVG，无框架依赖；样式用注入 `<style>` 或内联，类名带插件 id 前缀避免撞壳。
- `bun build` 会打包，但插件目录没有自己的 `package.json`：引第三方包会解析到仓库根 `node_modules`，
  等于把宿主依赖当插件依赖——不要这么做。
- 自己的持久状态用带 id 前缀的 localStorage 键（样例 `qaqh.padview.open`）。
- 构建：`pnpm plugins:build`（单次）/ `pnpm plugins`（watch），产物 `dist/entry.js` 不入库。

## 最小骨架

```ts
interface PluginHost {
  gamepadRaw?: (onFrame: (pad: Gamepad | null) => void) => () => void;
}

export default {
  mount(container: HTMLElement, host: PluginHost): () => void {
    const style = document.createElement("style");
    style.textContent = `.my-plugin-fab{position:fixed;right:16px;bottom:16px;pointer-events:auto;}`;
    document.head.append(style);

    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "my-plugin-fab";
    fab.textContent = "●";
    container.append(fab);

    const onClick = (): void => { /* … */ };
    fab.addEventListener("click", onClick);
    const unsub = host.gamepadRaw?.((pad) => { /* 每帧直写 DOM，无中间状态 */ }) ?? (() => undefined);

    return () => {
      unsub();
      fab.removeEventListener("click", onClick);
      style.remove();
      container.textContent = "";
    };
  },
};
```
