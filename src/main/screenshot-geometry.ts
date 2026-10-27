/** Coordinates are in desktop-independent pixels; image sizes are physical pixels. */
export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }

/**
 * Map a desktop selection to a crop of one display's captured image.
 * The captured image dimensions, not the display's nominal scale factor, determine
 * the mapping: capture backends may return a resized thumbnail. Each display must
 * be mapped separately because adjacent displays may have different scales.
 * Returns null when the selection does not cover an area on this display.
 */
export function selectionCrop(selection: Rect, display: Rect, image: Size): Rect | null {
  const values = [selection.x, selection.y, selection.width, selection.height,
    display.x, display.y, display.width, display.height, image.width, image.height];
  if (!values.every(Number.isFinite) || selection.width <= 0 || selection.height <= 0 ||
      display.width <= 0 || display.height <= 0 || !Number.isSafeInteger(image.width) ||
      !Number.isSafeInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new Error("Invalid screenshot geometry");
  }
  const left = Math.max(selection.x, display.x);
  const top = Math.max(selection.y, display.y);
  const right = Math.min(selection.x + selection.width, display.x + display.width);
  const bottom = Math.min(selection.y + selection.height, display.y + display.height);
  if (!(right > left && bottom > top)) return null;

  const x = Math.max(0, Math.floor((left - display.x) * image.width / display.width));
  const y = Math.max(0, Math.floor((top - display.y) * image.height / display.height));
  const endX = Math.min(image.width, Math.ceil((right - display.x) * image.width / display.width));
  const endY = Math.min(image.height, Math.ceil((bottom - display.y) * image.height / display.height));
  return { x, y, width: endX - x, height: endY - y };
}
