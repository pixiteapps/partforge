// collideBar with its swing declared as a sweep, for the CLI's `sweeps:` line: the bar
// meets the slab at 60°, so the row is a contact driven by `angle`.
import { collideBar } from "./collide-bar.js";

export default { ...collideBar, verify: { sweeps: { swing: { param: "angle" } } } };
