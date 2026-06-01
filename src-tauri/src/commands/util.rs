/**
 * Shared helpers for the `commands/` module. Keep this file tiny — only put
 * things here that are genuinely reused across ≥2 command files.
 */

use std::time::{SystemTime, UNIX_EPOCH};

/// Current wall-clock time as Unix epoch milliseconds. Returns 0 if the
/// system clock is before 1970 (impossible in practice; the saturating
/// behavior is just for "the function never panics" rather than meaningful
/// fallback).
pub fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_epoch_ms_is_increasing() {
        let a = current_epoch_ms();
        std::thread::sleep(std::time::Duration::from_millis(10));
        let b = current_epoch_ms();
        assert!(b > a, "{} should be > {}", b, a);
    }

    #[test]
    fn current_epoch_ms_after_2026() {
        // 2026-01-01T00:00:00Z ≈ 1767225600000 ms
        let now = current_epoch_ms();
        assert!(now > 1_767_225_600_000, "epoch_ms looks unrealistically low: {}", now);
    }
}
