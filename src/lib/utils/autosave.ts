/**
 * Autosave scheduling (v1.21.0) — dual-condition model replacing the old
 * fixed 30-second interval:
 *
 *  1. Max-interval: pending edits are force-saved at most `maxMinutes` after
 *     they began, even while the user keeps typing.
 *  2. Idle: pending edits are saved once the user has paused input for
 *     `idleMinutes`.
 *
 * Pure decision function — the caller owns the timestamps (a coarse ticker
 * polls this every ~15s, so trigger precision is ± one tick).
 */

export interface AutoSaveTiming {
  /** Force-save pending edits at most this many minutes after they began. */
  maxMinutes: number;
  /** Save once input has paused for this many minutes. */
  idleMinutes: number;
}

/**
 * @param now            current epoch ms
 * @param pendingSince   epoch ms when the first unsaved edit occurred (0 = no pending edits)
 * @param lastEditAt     epoch ms of the most recent edit (0 = unknown)
 */
export function shouldAutoSave(
  now: number,
  pendingSince: number,
  lastEditAt: number,
  timing: AutoSaveTiming
): boolean {
  if (pendingSince <= 0) return false;
  const maxMs = Math.max(1, timing.maxMinutes) * 60_000;
  const idleMs = Math.max(0.5, timing.idleMinutes) * 60_000;
  if (now - pendingSince >= maxMs) return true;
  if (lastEditAt > 0 && now - lastEditAt >= idleMs) return true;
  return false;
}
