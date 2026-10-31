/**
 * Coalesce paints, not characters. A paint always consumes the latest source.
 * The timeout bounds latency when rAF is paused; it is never reset by another
 * delta (debouncing an uninterrupted stream would starve its tail).
 */
export function createPaintScheduler(paint: () => void, now = () => performance.now()) {
  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let earliest = 0;

  const cancel = () => {
    if (frame != null) cancelAnimationFrame(frame);
    if (timer != null) clearTimeout(timer);
    frame = null;
    timer = null;
  };
  const flush = () => {
    cancel();
    paint();
  };
  const tick = () => {
    const remaining = earliest - now();
    if (remaining > 0) {
      if (frame != null) cancelAnimationFrame(frame);
      frame = null;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(tick, Math.min(remaining, 120));
      return;
    }
    flush();
  };
  return {
    schedule(notBefore = 0) {
      earliest = notBefore;
      if (frame != null || timer != null) return;
      frame = requestAnimationFrame(tick);
      timer = setTimeout(tick, Math.max(16, Math.min(120, earliest - now())));
    },
    flush,
    cancel,
  };
}
