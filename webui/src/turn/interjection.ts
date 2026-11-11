/**
 * 插话条目（timeline `input`）的呈现判定。
 *
 * 后端把看门狗提醒/折叠提示按**普通输入条目**进 timeline:契约里已有的
 * `purpose: "interject"` + `actor.kind: "api"`。这两档都不是新类型,但老的
 * transcript 渲染把 input 一律当"用户说的话",于是:
 * 1. 用户的原话被这条系统提示**顶掉**(回合气泡变成系统文案);
 * 2. 看起来像用户自己发了一句系统提示。
 * 判据顺序固定:`actor.kind` 先看(不是 user 就不是用户的话),
 * `actor.id === "handoff-watchdog"` 只用来挑更准的名字。
 */
import { STR } from "../lib/strings";
import { WATCHDOG_ACTOR_ID } from "../session/handoff";

export type InterjectionFacts = {
  purpose: string;
  actorKind: string;
  actorId: string;
  actorName?: string | null;
};

/** 这条 input 是不是"系统侧说的话"(api/system/agent/subagent 都算)。 */
export function isSystemInterjection(facts: InterjectionFacts): boolean {
  return facts.actorKind !== "user";
}

/** 行首标签:系统插话与用户自己的追加输入必须一眼可分。 */
export function interjectionLabel(facts: InterjectionFacts): string {
  if (isSystemInterjection(facts)) {
    if (facts.actorId === WATCHDOG_ACTOR_ID) return STR.interjectWatchdog;
    if (facts.actorName && facts.actorName.trim() !== "") return facts.actorName.trim();
    if (facts.actorKind === "agent" || facts.actorKind === "subagent") return STR.interjectAgent;
    return STR.interjectSystem;
  }
  if (facts.purpose === "steer") return STR.interjectSteer;
  if (facts.purpose === "queue_only") return STR.interjectQueued;
  if (facts.purpose === "interject") return STR.interjectUser;
  return STR.interjectExtra;
}

/** title 提示:把契约原值摆出来,别让用户猜这条是谁写的。 */
export function interjectionHint(facts: InterjectionFacts): string {
  return STR.interjectSource(facts.actorKind, facts.actorId, facts.purpose);
}
