/**
 * Coalesce paints, not characters. A paint always consumes the latest source.
 * The timeout bounds latency when rAF is paused; it is never reset by another
 * delta (debouncing an uninterrupted stream would starve its tail).
 *
 * `paint(finish)` gets `finish = true` when the frame is driven by the fallback
 * timer or by an explicit seal: the consumer must render everything and must
 * not arm another frame, so a paused tab can never strand a half-drawn reveal.
 * On a normal frame the consumer may call `schedule()` from inside `paint` to
 * continue a multi-frame reveal with a freshly computed deadline.
 */
export function createPaintScheduler(paint: (finish: boolean) => void, now = () => performance.now()) {
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
    paint(true);
  };
  const tick = (fallback: boolean) => {
    const remaining = earliest - now();
    // The fallback timer outranks an outstanding paint budget: once rAF is
    // paused the tail must be shown in full rather than left half-revealed.
    if (remaining > 0 && !fallback) {
      if (frame != null) cancelAnimationFrame(frame);
      frame = null;
      if (timer != null) clearTimeout(timer);
      timer = setTimeout(() => tick(true), Math.min(remaining, 120));
      return;
    }
    cancel();
    paint(fallback);
  };
  return {
    schedule(notBefore = 0) {
      earliest = notBefore;
      if (frame != null || timer != null) return;
      frame = requestAnimationFrame(() => tick(false));
      timer = setTimeout(() => tick(true), Math.max(16, Math.min(120, earliest - now())));
    },
    flush,
    cancel,
  };
}
