// The preview's play/pause/replay button (mount-preview.js): lets a visitor stop
// a cached preview's baked autoplay animation while they read the page. A plain
// `#viewbar button`, inserted directly before the view style button (#view-style,
// after its divider), so it inherits the toolbar's sizing and hover styles.
//
// Three states, read off the player's onChange notifications (never polled):
//   - Pause  while playing or during the intro camera tween;
//   - Play   while paused — resumes from the pose it froze at — or while a
//            mount with `autostart: false` waits at its first frame (starts it);
//   - Replay once a one-time animation has finished at its end pose — plays it
//            again from the start, camera cues included. A looping animation
//            never gets here.
// The label (aria-label, and the tooltip, which reads it each time it shows)
// names what a click does and so carries the state; there is deliberately no
// aria-pressed (WAI-ARIA: a toggle whose label changes must not also report a
// pressed state). A label change hides a tooltip that is showing, so it never
// reads the old action; it comes back with the new text on the next hover.
//
// Made only for a player that plays: mount-preview never creates it under
// reduced motion (the player never starts), for a still file, with
// animate: false, or for a host with no #viewbar. Nothing is remembered: a
// remount starts fresh.
import { attachButtonTooltips } from "./tooltip.js";

const svg = (body) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
// lucide "pause", "play" and "rotate-ccw".
const STATES = {
  pause: { label: "Pause animation", icon: svg(`<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>`) },
  play: { label: "Play animation", icon: svg(`<polygon points="6 3 20 12 6 21 6 3"/>`) },
  replay: { label: "Replay animation", icon: svg(`<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>`) },
};

// What a click does for a given player status.
const actionFor = (status) => (status === "paused" || status === "idle" ? "play" : status === "done" ? "replay" : "pause");

export function attachPreviewPlayButton(player, { toolbar, before = null }, { tooltip = null } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.id = "pf-preview-play";
  button.className = "pf-preview-play-button";
  let action = null;
  let tooltipBinding = null;

  function render(status) {
    const next = actionFor(status);
    if (next === action) return;
    action = next;
    const { label, icon } = STATES[next];
    button.innerHTML = icon;
    button.setAttribute("aria-label", label);
    if (!tooltip) button.title = label;
    tooltipBinding?.hide(); // a showing tooltip still names the old action
  }
  render(player.state().status);

  const anchor = before && before.parentElement === toolbar ? before : [...toolbar.children].find((c) => c.id === "theme") ?? null;
  toolbar.insertBefore(button, anchor);
  tooltipBinding = tooltip ? attachButtonTooltips(tooltip, [{ element: button }]) : null;

  const onClick = () => {
    if (action === "pause") player.pause();
    else if (action === "play") { if (player.state().status === "idle") player.start(); else player.resume(); }
    else player.replay();
  };
  button.addEventListener("click", onClick);
  const off = player.onChange((s) => render(s.status));

  return {
    element: button,
    detach() {
      off();
      button.removeEventListener("click", onClick);
      tooltipBinding?.detach();
      button.remove();
    },
  };
}
