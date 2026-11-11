/**
 * QAQ 插件 #1：手柄贪吃蛇（摸鱼向）。
 *
 * 纯 DOM + Canvas，无框架依赖。输入走宿主 facade 的 gamepadRaw（D-pad 方向、
 * A 开始/重开、B 收起），键盘方向键/WASD 同映射兜底（无手柄也能玩）。
 * 摸鱼边界：浮动按钮唤起，B 键收起，dispose 移除全部 DOM 与监听。
 */

const GRID = 20;
const CELL = 16;
const TICK_MS = 140;

type Point = { x: number; y: number };

const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
} as const;

type Dir = keyof typeof DIRS;

interface PluginHost {
  gamepadRaw?: (onFrame: (pad: Gamepad | null) => void) => () => void;
}

export default {
  mount(container: HTMLElement, host: PluginHost): () => void {
    const style = document.createElement("style");
    style.textContent = `
      .qaqh-snake-launch{position:fixed;right:16px;bottom:16px;pointer-events:auto;width:44px;height:44px;
        border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(24,24,27,.85);
        color:#edeef0;font-size:20px;display:grid;place-items:center;cursor:pointer;user-select:none;z-index:1;}
      .qaqh-snake-launch:hover{background:rgba(63,63,70,.9);}
      .qaqh-snake-panel{position:fixed;right:16px;bottom:70px;pointer-events:auto;z-index:1;
        border-radius:14px;background:rgba(18,18,20,.94);border:1px solid rgba(255,255,255,.14);
        box-shadow:0 12px 40px rgba(0,0,0,.45);padding:14px;color:#edeef0;
        font:12px/1.6 ui-sans-serif,system-ui;display:none;}
      .qaqh-snake-panel.open{display:block;}
      .qaqh-snake-head{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:10px;}
      .qaqh-snake-score{font-weight:600;}
      .qaqh-snake-hint{opacity:.55;margin-top:8px;}
      .qaqh-snake-canvas{display:block;image-rendering:pixelated;border-radius:8px;background:#101013;}
    `;
    document.head.append(style);

    const launch = document.createElement("button");
    launch.type = "button";
    launch.className = "qaqh-snake-launch";
    launch.title = "贪吃蛇（手柄/方向键）";
    launch.textContent = "🐍";

    const panel = document.createElement("div");
    panel.className = "qaqh-snake-panel";
    panel.innerHTML = `
      <div class="qaqh-snake-head">
        <span class="qaqh-snake-score">得分 0</span>
        <span>🐍</span>
      </div>
      <canvas class="qaqh-snake-canvas" width="${GRID * CELL}" height="${GRID * CELL}"></canvas>
      <div class="qaqh-snake-hint">A/回车 开始 · B/Esc 收起 · 方向键/WASD/D-pad 移动</div>
    `;

    const root = document.createElement("div");
    root.append(launch, panel);
    container.append(root);

    const canvas = panel.querySelector("canvas") as HTMLCanvasElement;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    const scoreEl = panel.querySelector(".qaqh-snake-score") as HTMLElement;

    // ---- 游戏状态 ----
    let snake: Point[] = [];
    let dir: Dir = "right";
    let pendingDir: Dir | null = null;
    let food: Point = { x: 0, y: 0 };
    let score = 0;
    let phase: "idle" | "running" | "dead" = "idle";
    let tickTimer: number | null = null;

    function spawnFood(): void {
      do {
        food = { x: Math.floor(Math.random() * GRID), y: Math.floor(Math.random() * GRID) };
      } while (snake.some((s) => s.x === food.x && s.y === food.y));
    }

    function reset(): void {
      snake = [{ x: 6, y: 10 }, { x: 5, y: 10 }, { x: 4, y: 10 }];
      dir = "right";
      pendingDir = null;
      score = 0;
      scoreEl.textContent = "得分 0";
      spawnFood();
    }

    function step(): void {
      if (pendingDir != null) {
        // 不允许 180° 掉头。
        if (DIRS[pendingDir].x !== -DIRS[dir].x || DIRS[pendingDir].y !== -DIRS[dir].y) dir = pendingDir;
        pendingDir = null;
      }
      const head = { x: snake[0].x + DIRS[dir].x, y: snake[0].y + DIRS[dir].y };
      const hitWall = head.x < 0 || head.y < 0 || head.x >= GRID || head.y >= GRID;
      const hitSelf = snake.some((s) => s.x === head.x && s.y === head.y);
      if (hitWall || hitSelf) {
        stopTick();
        phase = "dead";
        draw();
        return;
      }
      snake.unshift(head);
      if (head.x === food.x && head.y === food.y) {
        score += 1;
        scoreEl.textContent = `得分 ${score}`;
        spawnFood();
      } else {
        snake.pop();
      }
      draw();
    }

    function start(): void {
      stopTick();
      reset();
      phase = "running";
      tickTimer = window.setInterval(step, TICK_MS);
      draw();
    }

    function stopTick(): void {
      if (tickTimer != null) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
    }

    function draw(): void {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#22c55e";
      for (const s of snake) ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
      if (phase === "idle" || phase === "dead") {
        ctx.fillStyle = "rgba(0,0,0,.62)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#edeef0";
        ctx.font = "600 14px ui-sans-serif,system-ui";
        ctx.textAlign = "center";
        ctx.fillText(phase === "dead" ? `结束 · 得分 ${score}` : "贪吃蛇", canvas.width / 2, canvas.height / 2 - 6);
        ctx.font = "12px ui-sans-serif,system-ui";
        ctx.fillText("A / 回车 开始", canvas.width / 2, canvas.height / 2 + 14);
      }
    }

    // ---- 输入：手柄原始帧 + 键盘 ----
    function turn(d: Dir): void {
      if (phase === "running") pendingDir = d;
    }
    function confirmOrStart(): void {
      if (phase !== "running") start();
    }
    function collapse(): void {
      panel.classList.remove("open");
      stopTick();
      phase = "idle";
      draw();
    }

    const gamepadUnsub = host.gamepadRaw?.((pad) => {
      if (pad == null || !panel.classList.contains("open")) return;
      // D-pad (12-15) + 左摇杆死区方向；A=0 开始/重开，B=1 收起。
      if (pad.buttons[0]?.pressed) confirmOrStart();
      if (pad.buttons[1]?.pressed) collapse();
      if (pad.buttons[12]?.pressed) turn("up");
      if (pad.buttons[13]?.pressed) turn("down");
      if (pad.buttons[14]?.pressed) turn("left");
      if (pad.buttons[15]?.pressed) turn("right");
      const x = pad.axes[0] ?? 0;
      const y = pad.axes[1] ?? 0;
      if (Math.abs(y) > 0.55 && Math.abs(y) >= Math.abs(x)) turn(y < 0 ? "up" : "down");
      else if (Math.abs(x) > 0.55) turn(x < 0 ? "left" : "right");
    });

    function onKeyDown(event: KeyboardEvent): void {
      if (!panel.classList.contains("open")) return;
      const key = event.key.toLowerCase();
      if (key === "arrowup" || key === "w") turn("up");
      else if (key === "arrowdown" || key === "s") turn("down");
      else if (key === "arrowleft" || key === "a") turn("left");
      else if (key === "arrowright" || key === "d") turn("right");
      else if (key === "enter") confirmOrStart();
      else if (key === "escape") collapse();
      else return;
      event.preventDefault();
    }
    document.addEventListener("keydown", onKeyDown);

    launch.addEventListener("click", () => {
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) {
        if (phase !== "running") draw();
      } else collapse();
    });

    reset();
    draw();

    return () => {
      stopTick();
      gamepadUnsub?.();
      document.removeEventListener("keydown", onKeyDown);
      style.remove();
      container.textContent = "";
    };
  },
};
