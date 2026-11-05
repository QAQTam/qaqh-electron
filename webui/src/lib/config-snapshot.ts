import type { ConfigDto } from "../api/qaqh/ConfigDto";
import { transport } from "./transport";

// Share only in-flight reads. A completed value is never used as a fresh read.
let flight: Promise<ConfigDto> | null = null;
let generation = 0;

export function invalidateConfigSnapshot(): void {
  generation += 1;
  flight = null;
}

export function loadConfigSnapshot(): Promise<ConfigDto> {
  if (flight != null) return flight;
  const started = generation;
  const request = transport.query("config.load", {}).then(
    (value) => started === generation ? value : loadConfigSnapshot(),
    (error: unknown) => { if (started !== generation) return loadConfigSnapshot(); throw error; },
  );
  flight = request;
  void request.finally(() => { if (flight === request) flight = null; }).catch(() => {});
  return request;
}
