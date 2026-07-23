import { describe, it, expect } from 'vitest';
import { computeBreakOffsets, type BlockExtent } from './pdf-pagination';

/** Assert breaks are 0-based, strictly increasing, and end at totalHeight. */
function assertWellFormed(breaks: number[], totalHeight: number): void {
  expect(breaks[0]).toBe(0);
  expect(breaks[breaks.length - 1]).toBe(Math.round(totalHeight));
  for (let i = 1; i < breaks.length; i++) {
    expect(breaks[i]).toBeGreaterThan(breaks[i - 1]);
  }
}

/** A break must never fall strictly inside a block that starts on that page. */
function assertNoStraddle(breaks: number[], atoms: BlockExtent[]): void {
  for (let i = 1; i < breaks.length - 1; i++) {
    const cut = breaks[i];
    const pageTop = breaks[i - 1];
    for (const a of atoms) {
      const startsOnThisPage = a.top >= pageTop && a.top < cut;
      const tallerThanPage = a.bottom - a.top >= cut - pageTop;
      if (startsOnThisPage && !tallerThanPage) {
        expect(a.bottom).toBeLessThanOrEqual(cut);
      }
    }
  }
}

describe('computeBreakOffsets', () => {
  it('returns a single page when content fits', () => {
    expect(computeBreakOffsets([], 500, 1000)).toEqual([0, 500]);
  });

  it('paginates at the page height when there is nothing to avoid', () => {
    expect(computeBreakOffsets([], 2500, 1000)).toEqual([0, 1000, 2000, 2500]);
  });

  it('moves the cut up so a straddling block starts the next page', () => {
    // A block spanning 950..1100 straddles the natural cut at 1000.
    const atoms: BlockExtent[] = [{ top: 950, bottom: 1100 }];
    const breaks = computeBreakOffsets(atoms, 1500, 1000);
    // First page ends at 950 (block top), not 1000.
    expect(breaks[1]).toBe(950);
    assertWellFormed(breaks, 1500);
    assertNoStraddle(breaks, atoms);
  });

  it('keeps table rows whole across a page boundary', () => {
    // Rows every 120px; the one crossing 1000 must move down whole.
    const atoms: BlockExtent[] = [];
    for (let top = 0; top < 2000; top += 120) atoms.push({ top, bottom: top + 118 });
    const breaks = computeBreakOffsets(atoms, 2000, 1000);
    assertWellFormed(breaks, 2000);
    assertNoStraddle(breaks, atoms);
  });

  it('splits a block taller than a page rather than stalling', () => {
    // One giant block 0..2500 cannot fit on any 1000px page.
    const atoms: BlockExtent[] = [{ top: 0, bottom: 2500 }];
    const breaks = computeBreakOffsets(atoms, 2500, 1000);
    assertWellFormed(breaks, 2500);
    // Falls back to natural cuts.
    expect(breaks).toEqual([0, 1000, 2000, 2500]);
  });

  it('handles a page-tall block that starts mid-page', () => {
    // Block 600..1900 (1300px > page) starting after the top: cut moves to 600,
    // then the oversized block is split on the following page.
    const atoms: BlockExtent[] = [{ top: 600, bottom: 1900 }];
    const breaks = computeBreakOffsets(atoms, 2200, 1000);
    expect(breaks[1]).toBe(600);
    assertWellFormed(breaks, 2200);
  });

  it('is safe on zero / negative dimensions', () => {
    expect(computeBreakOffsets([], 0, 1000)).toEqual([0, 0]);
    expect(computeBreakOffsets([{ top: 0, bottom: 10 }], 100, 0)).toEqual([0, 100]);
  });

  it('never emits a stalled or non-increasing sequence for dense atoms', () => {
    const atoms: BlockExtent[] = [];
    for (let top = 0; top < 5000; top += 37) atoms.push({ top, bottom: top + 36 });
    const breaks = computeBreakOffsets(atoms, 5000, 800);
    assertWellFormed(breaks, 5000);
    assertNoStraddle(breaks, atoms);
  });
});
