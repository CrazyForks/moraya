/**
 * Time-decay weighting for memories (ported from web `src/lib/memory/decay.ts`,
 * operating on `MemoryDoc` with ISO-string dates).
 */
import type { MemoryDoc, MemoryHalfLife } from './types'

export const HALF_LIFE_OPTIONS: MemoryHalfLife[] = [30, 90, 180, 'never']

const BOOST_RECENT_7 = 1.5
const BOOST_RECENT_30 = 1.2
const BOOST_STALE = 1.0
const MS_PER_DAY = 1000 * 60 * 60 * 24

function ms(iso: string): number {
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? 0 : t
}

/**
 * Effective weight = base × exp(-ln2 × ageDays / halfLife) × recencyBoost,
 * capped at 1.0. `fixedWeight` memories bypass decay.
 */
export function effectiveWeight(
  doc: MemoryDoc,
  now: Date,
  halfLife: MemoryHalfLife = 90,
): number {
  if (doc.fixedWeight) return Math.min(doc.weight, 1.0)

  const ageDays = (now.getTime() - ms(doc.createdAt)) / MS_PER_DAY
  const sinceLastUsedDays = (now.getTime() - ms(doc.lastUsedAt)) / MS_PER_DAY

  const decay = halfLife === 'never' ? 1.0 : Math.exp((-Math.LN2 * ageDays) / halfLife)
  const boost =
    sinceLastUsedDays < 7 ? BOOST_RECENT_7 : sinceLastUsedDays < 30 ? BOOST_RECENT_30 : BOOST_STALE

  return Math.min(doc.weight * decay * boost, 1.0)
}

export function isStale(
  doc: MemoryDoc,
  now: Date,
  halfLife: MemoryHalfLife = 90,
  threshold = 0.1,
): boolean {
  return effectiveWeight(doc, now, halfLife) < threshold
}
