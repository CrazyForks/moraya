import { describe, it, expect } from 'vitest';
import { shouldAutoSave } from './autosave';

const MIN = 60_000;
const TIMING = { maxMinutes: 10, idleMinutes: 3 };

describe('shouldAutoSave', () => {
  it('should not save when there are no pending edits', () => {
    expect(shouldAutoSave(100 * MIN, 0, 99 * MIN, TIMING)).toBe(false);
  });

  it('should not save while typing continues within both windows', () => {
    const now = 20 * MIN;
    // edits began 5 min ago, last keystroke 10s ago
    expect(shouldAutoSave(now, now - 5 * MIN, now - 10_000, TIMING)).toBe(false);
  });

  it('should save once input has paused for idleMinutes', () => {
    const now = 20 * MIN;
    // edits began 4 min ago, last keystroke 3 min ago
    expect(shouldAutoSave(now, now - 4 * MIN, now - 3 * MIN, TIMING)).toBe(true);
  });

  it('should not save when the pause is shorter than idleMinutes', () => {
    const now = 20 * MIN;
    expect(shouldAutoSave(now, now - 4 * MIN, now - 2 * MIN, TIMING)).toBe(false);
  });

  it('should force-save at the max interval even while typing continuously', () => {
    const now = 20 * MIN;
    // edits began 10 min ago, still typing (last keystroke just now)
    expect(shouldAutoSave(now, now - 10 * MIN, now, TIMING)).toBe(true);
  });

  it('should not force-save before the max interval elapses', () => {
    const now = 20 * MIN;
    expect(shouldAutoSave(now, now - 9 * MIN, now, TIMING)).toBe(false);
  });

  it('should fall back to the max-interval branch when lastEditAt is unknown', () => {
    const now = 20 * MIN;
    expect(shouldAutoSave(now, now - 10 * MIN, 0, TIMING)).toBe(true);
    expect(shouldAutoSave(now, now - 5 * MIN, 0, TIMING)).toBe(false);
  });

  it('should clamp degenerate settings instead of firing constantly', () => {
    const now = 20 * MIN;
    // maxMinutes 0 clamps to 1 minute
    expect(shouldAutoSave(now, now - 30_000, now, { maxMinutes: 0, idleMinutes: 0 })).toBe(false);
    expect(shouldAutoSave(now, now - MIN, now, { maxMinutes: 0, idleMinutes: 0 })).toBe(true);
  });
});
