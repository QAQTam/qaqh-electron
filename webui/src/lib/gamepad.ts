/** Small, browser-only Gamepad API adapter for QAQ navigation (no OS input injection). */
export type GamepadDirection = "up" | "down" | "left" | "right";
export type GamepadAction =
  | { kind: "move"; direction: GamepadDirection }
  | { kind: "confirm" }
  | { kind: "cancel" }
  | { kind: "send" }
  | { kind: "toggle-panel" }
  | { kind: "focus-composer" }
  | { kind: "toggle-mode" }
  | { kind: "voice-start" }
  | { kind: "voice-stop" };

export type GamepadPromptFamily = "xbox" | "playstation" | "generic";
export const GAMEPAD_ACTION_EVENT = "qaqh:gamepad-action";

export function dispatchGamepadAction(action: GamepadAction): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<GamepadAction>(GAMEPAD_ACTION_EVENT, { detail: action }));
}

export function gamepadPromptFamily(id: string): GamepadPromptFamily {
  const value = id.toLowerCase();
  if (/dualsense|dualshock|playstation|sony|054c|^54c-/.test(value)) return "playstation";
  if (/xbox|xinput|045e/.test(value)) return "xbox";
  return "generic";
}

export function supportsGamepadActions(device: Pick<GamepadDeviceState, "mapping" | "family">): boolean {
  return device.mapping === "standard" || device.family !== "generic";
}

export function gamepadPrompts(family: GamepadPromptFamily): {
  confirm: string;
  cancel: string;
  send: string;
  panel: string;
  focus: string;
} {
  if (family === "playstation") {
    return { confirm: "×", cancel: "○", send: "□", panel: "△", focus: "L2 / R2" };
  }
  if (family === "xbox") {
    return { confirm: "A", cancel: "B", send: "X", panel: "Y", focus: "LT / RT" };
  }
  return { confirm: "底部键", cancel: "右侧键", send: "左侧键", panel: "顶部键", focus: "扳机" };
}

const BUTTON_CONFIRM = 0;
const BUTTON_CANCEL = 1;
const BUTTON_SEND = 2;
const BUTTON_PANEL = 3;
const BUTTON_LEFT_TRIGGER = 6;
const BUTTON_RIGHT_TRIGGER = 7;
const BUTTON_DPAD_UP = 12;
const BUTTON_DPAD_DOWN = 13;
const BUTTON_DPAD_LEFT = 14;
const BUTTON_DPAD_RIGHT = 15;
// Chromium may omit the system Guide/Home button. The in-app mode toggle is always available.
const BUTTON_GUIDE = 16;
const AXIS_LEFT_X = 0;
const AXIS_LEFT_Y = 1;
const AXIS_DEADZONE = 0.55;
const TRIGGER_THRESHOLD = 0.55;
const REPEAT_DELAY_MS = 360;
const REPEAT_INTERVAL_MS = 140;
/** 扳机按住超过这个时长判定为 push-to-talk；短按仍是聚焦 composer。 */
const TRIGGER_HOLD_MS = 450;

/** tick 里持续刷新的当前手柄，用于振动回馈(Chromium 支持 dual-rumble)。 */
let activePad: Gamepad | null = null;

/**
 * 让手柄震一下：语音播报结束、录音开始等"不看屏也知道有事"的时刻用。
 * 不支持振动促动器的设备静默返回 false。
 */
export function vibrateGamepad(durationMs = 180, strong = 0.5, weak = 0.25): boolean {
  const actuator = activePad?.vibrationActuator as
    | { playEffect?: (type: string, options: { duration: number; strongMagnitude: number; weakMagnitude: number }) => Promise<unknown> }
    | undefined;
  if (actuator?.playEffect == null) return false;
  void actuator.playEffect("dual-rumble", { duration: durationMs, strongMagnitude: strong, weakMagnitude: weak }).catch(() => undefined);
  return true;
}

export type GamepadDeviceState = {
  connected: boolean;
  id: string;
  mapping: string;
  family: GamepadPromptFamily;
};

function buttonPressed(pad: Gamepad, index: number, threshold = 0.5): boolean {
  const button = pad.buttons[index];
  return button != null && (button.pressed || button.value >= threshold);
}

function directionFromPad(pad: Gamepad): GamepadDirection | null {
  if (buttonPressed(pad, BUTTON_DPAD_UP)) return "up";
  if (buttonPressed(pad, BUTTON_DPAD_DOWN)) return "down";
  if (buttonPressed(pad, BUTTON_DPAD_LEFT)) return "left";
  if (buttonPressed(pad, BUTTON_DPAD_RIGHT)) return "right";
  const x = pad.axes[AXIS_LEFT_X] ?? 0;
  const y = pad.axes[AXIS_LEFT_Y] ?? 0;
  if (Math.abs(y) >= AXIS_DEADZONE && Math.abs(y) >= Math.abs(x)) return y < 0 ? "up" : "down";
  if (Math.abs(x) >= AXIS_DEADZONE) return x < 0 ? "left" : "right";
  return null;
}

/**
 * Poll only while a controller is connected. Guide/Home is watched even outside navigation mode;
 * all other controls are ignored until the user explicitly enables the mode.
 */
export class GamepadController {
  private frame = 0;
  private timer: number | null = null;
  private running = false;
  private lastPadIndex: number | null = null;
  private lastEnabled = false;
  private readonly previousButtons = new Map<number, boolean[]>();
  private readonly guidePreviousButtons = new Map<number, boolean[]>();
  private repeatedDirection: GamepadDirection | null = null;
  private directionStartedAt = 0;
  private lastDirectionAt = 0;
  private triggerDownAt = 0;
  private triggerVoiceWanted = false;
  private triggerVoiceOpened = false;

  constructor(
    private readonly enabled: () => boolean,
    private readonly onAction: (action: GamepadAction) => void,
    private readonly onDevice: (state: GamepadDeviceState) => void,
    /** 语音能力开没开(决定扳机走 PTT 还是纯聚焦)。 */
    private readonly voiceEnabled: () => boolean = () => false,
  ) {}

  start(): () => void {
    if (this.running || typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
      return () => this.stop();
    }
    this.running = true;
    window.addEventListener("gamepadconnected", this.handleConnection);
    window.addEventListener("gamepaddisconnected", this.handleConnection);
    this.tick();
    return () => this.stop();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    window.removeEventListener("gamepadconnected", this.handleConnection);
    window.removeEventListener("gamepaddisconnected", this.handleConnection);
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    if (this.timer != null) window.clearTimeout(this.timer);
    this.frame = 0;
    this.timer = null;
    this.lastPadIndex = null;
    this.lastEnabled = false;
    this.previousButtons.clear();
    this.guidePreviousButtons.clear();
    this.onDevice({ connected: false, id: "", mapping: "", family: "generic" });
  }

  private readonly handleConnection = (): void => {
    if (this.running && this.frame === 0 && this.timer == null) this.tick();
  };

  private scheduleRetry(): void {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.tick();
    }, 150);
  }

  private tick = (): void => {
    if (!this.running) return;
    this.frame = 0;
    let pads: (Gamepad | null)[] = [];
    try {
      pads = Array.from(navigator.getGamepads());
    } catch {
      // Some Chromium/Linux controller stacks throw during hot unplug; retry on the next frame.
    }
    const connected = pads.filter((pad): pad is Gamepad => pad != null && pad.connected);
    const pad = connected[0];

    if (pad == null) {
      if (this.lastPadIndex != null) {
        this.lastPadIndex = null;
        this.previousButtons.clear();
        this.guidePreviousButtons.clear();
        this.repeatedDirection = null;
        if (this.triggerVoiceOpened) {
          this.triggerVoiceOpened = false;
          this.onAction({ kind: "voice-stop" }); // 热拔不挂麦:按松手语义收尾。
        }
        this.onDevice({ connected: false, id: "", mapping: "", family: "generic" });
      }
      this.scheduleRetry();
      return;
    }

    if (pad.index !== this.lastPadIndex) {
      this.lastPadIndex = pad.index;
      this.lastEnabled = false;
      this.previousButtons.clear();
      this.guidePreviousButtons.clear();
      this.onDevice({
        connected: true,
        id: pad.id,
        mapping: pad.mapping,
        family: gamepadPromptFamily(pad.id),
      });
    }

    const active = this.enabled();
    const wasActive = this.lastEnabled;
    this.lastEnabled = active;
    activePad = pad;
    const now = performance.now();
    const previous = this.previousButtons.get(pad.index) ?? [];
    const guidePrevious = this.guidePreviousButtons.get(pad.index) ?? [];
    const current = pad.buttons.map((button) => button.pressed || button.value >= TRIGGER_THRESHOLD);
    const justPressed = (index: number, from: boolean[] = previous): boolean => current[index] === true && from[index] !== true;

    const guidePressed = justPressed(BUTTON_GUIDE, guidePrevious);
    if (guidePressed) this.onAction({ kind: "toggle-mode" });
    if (!guidePressed && active && wasActive && supportsGamepadActions({ mapping: pad.mapping, family: gamepadPromptFamily(pad.id) })) {
      if (justPressed(BUTTON_CONFIRM)) this.onAction({ kind: "confirm" });
      if (justPressed(BUTTON_CANCEL)) this.onAction({ kind: "cancel" });
      if (justPressed(BUTTON_SEND)) this.onAction({ kind: "send" });
      if (justPressed(BUTTON_PANEL)) this.onAction({ kind: "toggle-panel" });
      this.pollTrigger(now, current, previous);
      this.pollDirection(pad, performance.now());
    } else {
      this.repeatedDirection = null;
      if (this.triggerVoiceOpened) {
        this.triggerVoiceOpened = false;
        this.onAction({ kind: "voice-stop" }); // 模式中途退出:兜底收麦。
      }
    }

    this.guidePreviousButtons.set(pad.index, current);
    this.previousButtons.set(pad.index, current);
    this.frame = requestAnimationFrame(this.tick);
  };

  /** 扳机状态机:按下 latch 意图,跨过时长线开麦,松手收尾(或短按聚焦)。 */
  private pollTrigger(now: number, current: boolean[], previous: boolean[]): void {
    const down = current[BUTTON_LEFT_TRIGGER] === true || current[BUTTON_RIGHT_TRIGGER] === true;
    const wasDown = previous[BUTTON_LEFT_TRIGGER] === true || previous[BUTTON_RIGHT_TRIGGER] === true;
    if (down && !wasDown) {
      this.triggerDownAt = now;
      this.triggerVoiceWanted = this.voiceEnabled();
      return;
    }
    if (down && this.triggerVoiceWanted && !this.triggerVoiceOpened && now - this.triggerDownAt >= TRIGGER_HOLD_MS) {
      this.triggerVoiceOpened = true;
      this.onAction({ kind: "voice-start" });
      return;
    }
    if (!down && wasDown) {
      if (this.triggerVoiceOpened) {
        this.triggerVoiceOpened = false;
        this.onAction({ kind: "voice-stop" });
      } else if (this.triggerVoiceWanted && this.triggerDownAt > 0) {
        this.onAction({ kind: "focus-composer" }); // 想语音但没按够时长：退回原语义。
      } else if (!this.triggerVoiceWanted) {
        this.onAction({ kind: "focus-composer" });
      }
      this.triggerDownAt = 0;
    }
  }

  private pollDirection(pad: Gamepad, now: number): void {
    const direction = directionFromPad(pad);
    if (direction == null) {
      this.repeatedDirection = null;
      return;
    }
    if (direction !== this.repeatedDirection) {
      this.repeatedDirection = direction;
      this.directionStartedAt = now;
      this.lastDirectionAt = now;
      this.onAction({ kind: "move", direction });
      return;
    }
    if (now - this.directionStartedAt >= REPEAT_DELAY_MS && now - this.lastDirectionAt >= REPEAT_INTERVAL_MS) {
      this.lastDirectionAt = now;
      this.onAction({ kind: "move", direction });
    }
  }
}

/**
 * Raw per-frame pad feed for plugin hosts: hands the connected pad (or null) to
 * the caller every animation frame. Unlike the navigation controller it carries
 * analog values and simultaneous buttons — menu throttling does not apply.
 * Each caller owns its feed; an unsubscribe stops its own loop only.
 */
export function startGamepadRawFeed(onFrame: (pad: Gamepad | null) => void): () => void {
  let frame = 0;
  const tick = (): void => {
    frame = 0;
    let pad: Gamepad | null = null;
    try {
      const pads = Array.from(navigator.getGamepads());
      pad = pads.find((candidate) => candidate != null && candidate.connected) ?? null;
    } catch {
      // Chromium/Linux 控制器栈热拔出会 throw；下一帧自然恢复，与导航控制器同语义。
    }
    onFrame(pad);
    frame = requestAnimationFrame(tick);
  };
  if (typeof navigator !== "undefined" && typeof navigator.getGamepads === "function") tick();
  else onFrame(null);
  return () => {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
  };
}
