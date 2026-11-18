// Every view of a part and the animations each declares, in declaration order,
// plus the view mount() opens on (0.194.0). For a host that caches one preview
// per (view, animation) and lets a forge's owner choose which one plays: it needs
// the names to key on and the labels to show, with no kernel and no build.
//
// Pure and DOM-free (it is on partforge/oracle's closure): views come from
// part.views, animations from viewAnimations (which drops a malformed animation
// the way the viewer does — lint reports it), the default view from
// resolveDefaultView.
import { viewAnimations } from "./animation.js";
import { resolveDefaultView } from "./default-view.js";

const isPlainObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

export function listViewAnimations(part) {
  const views = isPlainObject(part?.views) ? part.views : {};
  const anims = viewAnimations(part);
  return {
    defaultView: resolveDefaultView(part),
    views: Object.entries(views).map(([name, view]) => ({
      name,
      label: typeof view?.label === "string" && view.label ? view.label : name,
      animations: (anims.get(name) ?? []).map((a) => ({ name: a.name, label: a.label, autoplay: a.autoplay === true })),
    })),
  };
}
