import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => { vi.unstubAllGlobals(); });
import { gamepadPromptFamily, gamepadPrompts, GamepadController, supportsGamepadActions, type GamepadAction } from "../src/lib/gamepad";

describe("gamepad prompt mapping", () => {
  it("shows Xbox-style labels for XInput / Xbox Series devices", () => {
    expect(gamepadPromptFamily("Xbox Series X Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b12)"))
      .toBe("xbox");
    expect(gamepadPrompts("xbox")).toMatchObject({ confirm: "A", cancel: "B", send: "X", panel: "Y" });
  });

  it("shows PlayStation-style prompts for DualSense / Sony controller ids", () => {
    expect(gamepadPromptFamily("54c-ce6-Wireless Controller")).toBe("playstation");
    expect(gamepadPromptFamily("DualSense Wireless Controller")).toBe("playstation");
    expect(gamepadPrompts("playstation")).toMatchObject({ confirm: "×", cancel: "○", send: "□", panel: "△" });
  });

  it("does not guess a brand when the browser gives an unknown device id", () => {
    expect(gamepadPromptFamily("8BitDo Ultimate Controller")).toBe("generic");
    expect(gamepadPrompts("generic")).toMatchObject({ confirm: "底部键", cancel: "右侧键" });
    expect(supportsGamepadActions({ mapping: "", family: "generic" })).toBe(false);
    expect(supportsGamepadActions({ mapping: "standard", family: "generic" })).toBe(true);
    expect(supportsGamepadActions({ mapping: "", family: "xbox" })).toBe(true);
  });

  it("uses d-pad / left stick directions and emits one confirm on a button edge", () => {
    const actions: GamepadAction[] = [];
    const controller = new GamepadController(() => true, (action) => actions.push(action), () => {});
    const callbacks: FrameRequestCallback[] = [];
    let pad: Gamepad | null = null;
    vi.stubGlobal("navigator", {
      getGamepads: () => [pad],
    });
    vi.stubGlobal("window", {
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0, touched: false }));
    const axes = [0, 0];
    pad = {
      id: "Xbox Series Controller",
      index: 0,
      connected: true,
      mapping: "standard",
      timestamp: 1,
      axes,
      buttons,
      vibrationActuator: null,
      hapticActuators: [],
    } as unknown as Gamepad;

    controller.start();
    expect(actions).toEqual([]); // A held during connect is not an accidental approval.
    buttons[0]!.pressed = true;
    callbacks.shift()!(16);
    callbacks.shift()!(32);
    expect(actions).toEqual([{ kind: "confirm" }]); // Held A does not repeat.
    buttons[0]!.pressed = false;
    axes[1] = 0.9;
    callbacks.shift()!(48);
    expect(actions.at(-1)).toEqual({ kind: "move", direction: "down" });
    controller.stop();
  });
});
