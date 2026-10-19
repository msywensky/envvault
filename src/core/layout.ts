// Window placement for mini mode (src/main/mini.ts): pure, so it's unit-tested.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/**
 * Resize `from` to `size`, keeping its top-left corner where it fits, and
 * move it back inside `area` (the display's work area) where it doesn't.
 */
export function placeWithin(from: Rect, size: Size, area: Rect): Rect {
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)
  return {
    x: clamp(from.x, area.x, area.x + area.width - width),
    y: clamp(from.y, area.y, area.y + area.height - height),
    width,
    height
  }
}
