// The no-op pose surface: what `handle.pose` is on a mount with no Pose mode to drive
// (a part with no `handles`, or a cached preview mounted without `part`). A leaf, so
// mount.js and mount-preview.js share it without one importing the other.
export const NOOP_POSE = { isEnabled: () => false, setEnabled: () => {}, isLive: () => false, pinCount: () => 0, releasePins: () => {}, handlePoints: () => [] };
