import { AppError } from '@/lib/errors/app-error'

// Deterministic PRNG for dev seed data. The same seed always produces a
// byte-identical dataset, so screenshots, analytics totals, and test assertions
// stay stable across runs. Never use this for anything security-sensitive —
// mulberry32 is fast and well-distributed, not cryptographic.

// 2^32, the divisor that maps a uint32 into [0, 1).
const UINT32_RANGE = 0x100000000
const HEX_DIGITS = '0123456789abcdef'
// UUID v4 layout: 8-4-4-4-12. Hyphens follow these zero-based nibble indexes.
const UUID_HYPHEN_AFTER = new Set([7, 11, 15, 19])
const UUID_VERSION_INDEX = 12
const UUID_VARIANT_INDEX = 16
const UUID_NIBBLE_COUNT = 32

export interface Rng {
  /** Float in [0, 1). */
  next(): number
  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number
  /** Uniform choice from a non-empty array. */
  pick<T>(items: readonly T[]): T
  /** Choice from [value, weight] pairs; higher weight is likelier. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T
  /** True with the given probability in [0, 1]. */
  bool(probability: number): boolean
  /** Fisher-Yates copy — the input array is never mutated. */
  shuffle<T>(items: readonly T[]): T[]
  /** `count` distinct members of `items`, capped at `items.length`. */
  sample<T>(items: readonly T[], count: number): T[]
  /** RFC-4122-shaped v4 UUID, deterministic for a given seed. */
  uuid(): string
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE
  }
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed)

  const int = (min: number, max: number): number => {
    if (max < min) {
      throw new AppError('INVARIANT_VIOLATION', 'rng.int called with max < min', { min, max })
    }
    return min + Math.floor(next() * (max - min + 1))
  }

  const pick = <T,>(items: readonly T[]): T => {
    if (items.length === 0) {
      throw new AppError('INVARIANT_VIOLATION', 'rng.pick called with an empty array', {})
    }
    // Safe: int() is bounded by length - 1 and length is non-zero.
    return items[int(0, items.length - 1)]!
  }

  const weighted = <T,>(entries: readonly (readonly [T, number])[]): T => {
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0)
    if (entries.length === 0 || total <= 0) {
      throw new AppError('INVARIANT_VIOLATION', 'rng.weighted needs a positive total weight', {
        entryCount: entries.length,
        total,
      })
    }
    let roll = next() * total
    for (const [value, weight] of entries) {
      roll -= weight
      if (roll < 0) return value
    }
    // Only reachable through floating-point accumulation error at the very top
    // of the range; the last entry is the correct bucket there.
    return entries[entries.length - 1]![0]
  }

  const shuffle = <T,>(items: readonly T[]): T[] => {
    const copy = [...items]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = int(0, i)
      // Safe: both indexes are within [0, copy.length - 1].
      const a = copy[i]!
      const b = copy[j]!
      copy[i] = b
      copy[j] = a
    }
    return copy
  }

  const uuid = (): string => {
    let out = ''
    for (let i = 0; i < UUID_NIBBLE_COUNT; i++) {
      if (i === UUID_VERSION_INDEX) out += '4'
      // Variant nibble must be one of 8, 9, a, b.
      else if (i === UUID_VARIANT_INDEX) out += HEX_DIGITS[8 + int(0, 3)]
      else out += HEX_DIGITS[int(0, 15)]
      if (UUID_HYPHEN_AFTER.has(i)) out += '-'
    }
    return out
  }

  return {
    next,
    int,
    pick,
    weighted,
    bool: (probability) => next() < probability,
    shuffle,
    sample: (items, count) => shuffle(items).slice(0, Math.max(0, Math.min(count, items.length))),
    uuid,
  }
}
