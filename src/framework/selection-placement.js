// Where the selection popover sits relative to the pick marker. Pure: handed
// measurements, returns geometry. Moved here from partforge-cloud's
// pickBubblePlacement.js (2026-10-14) when the pick bubble became partforge's.
//
// `tailInset` must stay above the popover's corner radius, or the tail can land
// on the curve. `gutter` is the clearance kept at each stage edge.
export const SELECTION_GUTTER = 12;

export function planSelectionPlacement({ anchor, box, stage }, options = {}) {
  // Destructuring defaults, not a spread: an explicit `undefined` from a caller
  // forwarding options must fall back, not yield NaN.
  const { gap = 10, tailInset = 28, gutter = SELECTION_GUTTER } = options;
  const minLeft = stage.left + gutter;
  const maxLeft = stage.left + stage.width - gutter - box.width;
  const centred = anchor.x - box.width / 2;
  // A box wider than the stage inverts the clamp; pin it to the left gutter.
  const left = maxLeft < minLeft ? minLeft : Math.min(Math.max(centred, minLeft), maxLeft);
  const belowTop = anchor.y + gap;
  const roomBelow = stage.top + stage.height - gutter - belowTop;
  const roomAbove = anchor.y - gap - (stage.top + gutter);
  const fitsBelow = box.height <= roomBelow;
  const fitsAbove = box.height <= roomAbove;
  // Neither fitting takes the side with more room (ties below); the caller caps
  // the box's height to `maxHeight` so it scrolls instead of leaving the stage.
  const side = fitsBelow || (!fitsAbove && roomBelow >= roomAbove) ? "below" : "above";
  const room = side === "below" ? roomBelow : roomAbove;
  const aboveTop = anchor.y - gap - Math.min(box.height, Math.max(room, 0));
  // From the ROUNDED left — the edge actually painted — or an odd width puts
  // the tail a pixel off the dot.
  const painted = Math.round(left);
  const tail = anchor.x - painted;
  const tailFits = tail >= tailInset && tail <= box.width - tailInset;
  return {
    left: painted,
    top: Math.round(side === "below" ? belowTop : aboveTop),
    side,
    maxHeight: Math.max(0, Math.floor(room)),
    tailOffset: anchor.visible !== false && tailFits ? Math.round(tail) : null,
  };
}
