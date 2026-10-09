// What a plan file says is done: its tick-boxes. `- [ ] 1. Title` is open, `- [x] 1. Title` is done.
// Used by the plan gate (is anything left?) and by a builder session that keeps going item by item.
// Pure text, so the engine and tests share one definition.

export interface PlanProgress {
  total: number
  done: number
  /** The text after each unticked box, in plan order. */
  open: string[]
}

const BOX = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s*(.*)$/gm

export function planProgress(text: string): PlanProgress {
  const items = [...text.matchAll(BOX)]
  const open = items.filter((m) => m[1] === ' ').map((m) => m[2].trim())
  return { total: items.length, done: items.length - open.length, open }
}
