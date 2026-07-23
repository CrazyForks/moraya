import { describe, it, expect } from 'vitest';
import {
  threeWayMergeLines,
  twoWayMergeLines,
  assembleMerged,
  conflictChunkCount,
} from './merge';
import type { ChunkPick } from './types';

describe('threeWayMergeLines', () => {
  it('auto-merges non-overlapping edits on both sides', () => {
    const base = 'line1\nline2\nline3';
    const local = 'LINE1\nline2\nline3';   // changed first line
    const remote = 'line1\nline2\nLINE3';  // changed last line
    const r = threeWayMergeLines(local, base, remote);
    expect(r.hasConflict).toBe(false);
    expect(r.mergedText).toBe('LINE1\nline2\nLINE3');
  });

  it('reports a conflict when both sides change the same line differently', () => {
    const base = 'a\nb\nc';
    const local = 'a\nLOCAL\nc';
    const remote = 'a\nREMOTE\nc';
    const r = threeWayMergeLines(local, base, remote);
    expect(r.hasConflict).toBe(true);
    expect(r.mergedText).toBeNull();
    expect(conflictChunkCount(r)).toBe(1);
    const conflict = r.chunks.find((c) => c.type === 'conflict');
    expect(conflict?.local).toEqual(['LOCAL']);
    expect(conflict?.remote).toEqual(['REMOTE']);
    expect(conflict?.base).toEqual(['b']);
  });

  it('is not a conflict when both sides make the identical change', () => {
    const base = 'a\nb\nc';
    const local = 'a\nSAME\nc';
    const remote = 'a\nSAME\nc';
    const r = threeWayMergeLines(local, base, remote);
    expect(r.hasConflict).toBe(false);
    expect(r.mergedText).toBe('a\nSAME\nc');
  });

  it('takes the changed side when the other side is unchanged', () => {
    const base = 'a\nb\nc';
    const local = 'a\nb\nc';         // unchanged
    const remote = 'a\nb\nc\nd';     // appended
    const r = threeWayMergeLines(local, base, remote);
    expect(r.hasConflict).toBe(false);
    expect(r.mergedText).toBe('a\nb\nc\nd');
  });
});

describe('twoWayMergeLines (no base)', () => {
  it('passes identical content through with no conflict', () => {
    const r = twoWayMergeLines('x\ny\nz', 'x\ny\nz');
    expect(r.hasConflict).toBe(false);
    expect(r.mergedText).toBe('x\ny\nz');
  });

  it('surfaces differing regions as base-less conflicts', () => {
    const local = 'a\nLOCAL\nc';
    const remote = 'a\nREMOTE\nc';
    const r = twoWayMergeLines(local, remote);
    expect(r.hasConflict).toBe(true);
    const conflict = r.chunks.find((c) => c.type === 'conflict');
    expect(conflict?.local).toEqual(['LOCAL']);
    expect(conflict?.remote).toEqual(['REMOTE']);
    expect(conflict?.base).toBeUndefined();
  });
});

describe('assembleMerged', () => {
  const base = 'a\nb\nc';
  const local = 'a\nLOCAL\nc';
  const remote = 'a\nREMOTE\nc';

  it('assembles with per-chunk picks', () => {
    const r = threeWayMergeLines(local, base, remote);
    const takeLocal = assembleMerged(r, new Map<number, ChunkPick>([[0, 'local']]));
    expect(takeLocal).toBe('a\nLOCAL\nc');
    const takeRemote = assembleMerged(r, new Map<number, ChunkPick>([[0, 'remote']]));
    expect(takeRemote).toBe('a\nREMOTE\nc');
    const both = assembleMerged(r, new Map<number, ChunkPick>([[0, 'both-local-first']]));
    expect(both).toBe('a\nLOCAL\nREMOTE\nc');
  });

  it('falls back to the default pick for unresolved chunks', () => {
    const r = threeWayMergeLines(local, base, remote);
    expect(assembleMerged(r, new Map(), 'remote')).toBe('a\nREMOTE\nc');
  });
});
