// Lifecycle constants. "截存" = capture & stash *for a few days* — the tray is
// a staging area, not an archive, so items expire instead of accumulating.

/** Tray items older than this are swept (background alarm + popup load). */
export const TRAY_TTL_DAYS = 7;
export const TRAY_TTL_MS = TRAY_TTL_DAYS * 24 * 60 * 60 * 1000;

/**
 * A PendingCapture only needs to survive the hop from background capture to
 * the editor tab. Anything older means the user closed the editor without
 * saving — sweep it.
 */
export const PENDING_TTL_MS = 30 * 60 * 1000;
