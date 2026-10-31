import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** One writable component root for bootstrap, seeding, daemon and updater. */
export function userComponentRoot(): string {
  const override = process.env.QAQH_COMPONENT_ROOT?.trim();
  if (override) return resolve(override);
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  return join(dataHome || join(homedir(), ".local", "share"), "QAQ-Harness");
}
