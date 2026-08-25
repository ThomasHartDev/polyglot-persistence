export type AccessShape = 'point' | 'prefix-scan' | 'monotonic-append'

export const FEED_LAYOUT = {
  usersPk: { access: 'point', sequential: true },
  postsPk: { access: 'point', sequential: true },
  followsByFollower: { access: 'prefix-scan', sequential: false },
  postsByAuthor: { access: 'prefix-scan', sequential: false },
  postsByCreatedAt: { access: 'monotonic-append', sequential: true },
} as const

export type FeedIndex = keyof typeof FEED_LAYOUT

export function shouldHashShard(access: AccessShape, sequential: boolean): boolean {
  if (access === 'prefix-scan') return false
  if (access === 'monotonic-append') return true
  return sequential
}

export function layoutHash(index: FeedIndex): boolean {
  const row = FEED_LAYOUT[index]
  return shouldHashShard(row.access, row.sequential)
}

export function fnv1a(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function hashBucket(key: string, bucketCount: number): number {
  if (!Number.isInteger(bucketCount) || bucketCount < 2 || (bucketCount & (bucketCount - 1)) !== 0) {
    throw new RangeError('bucketCount must be a power of two >= 2')
  }
  return fnv1a(key) & (bucketCount - 1)
}

export function serialKey(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('serial must be a non-negative integer')
  return n.toString(16).padStart(16, '0')
}

export function uuidKey(seed: number): string {
  const a = fnv1a(`u:${seed}`).toString(16).padStart(8, '0')
  const b = fnv1a(`v:${seed}`).toString(16).padStart(8, '0')
  return a + b
}

export function hashShardedKey(key: string, bucketCount: number): string {
  return `${hashBucket(key, bucketCount).toString(16).padStart(4, '0')}/${key}`
}

export function orderedIndexKey(prefix: string, createdAt: number, id: string): string {
  return `${prefix}/${serialKey(createdAt)}/${id}`
}

export function hashShardedIndexKey(createdAt: number, id: string, bucketCount: number): string {
  return hashShardedKey(orderedIndexKey('', createdAt, id), bucketCount)
}

interface Range {
  start: string
  keys: string[]
}

export class Keyspace {
  private readonly ranges: Range[] = [{ start: '', keys: [] }]

  constructor(readonly splitAfter: number) {
    if (!Number.isInteger(splitAfter) || splitAfter < 2) {
      throw new RangeError('splitAfter must be an integer >= 2')
    }
  }

  rangeCount(): number {
    return this.ranges.length
  }

  rangeIndex(key: string): number {
    let lo = 0
    let hi = this.ranges.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const start = this.ranges[mid]?.start
      if (start !== undefined && start <= key) lo = mid + 1
      else hi = mid
    }
    return Math.max(0, lo - 1)
  }

  insert(key: string): number {
    let i = this.rangeIndex(key)
    const range = this.ranges[i]
    if (!range) throw new Error('missing range')
    insertSorted(range.keys, key)
    if (range.keys.length > this.splitAfter) {
      this.split(i)
      i = this.rangeIndex(key)
    }
    return i
  }

  hottestShare(keys: readonly string[]): number {
    if (keys.length === 0) return 0
    const counts = new Map<number, number>()
    let max = 0
    for (const key of keys) {
      const i = this.rangeIndex(key)
      const n = (counts.get(i) ?? 0) + 1
      counts.set(i, n)
      if (n > max) max = n
    }
    return max / keys.length
  }

  private split(i: number): void {
    const range = this.ranges[i]
    if (!range) return
    const mid = Math.floor(range.keys.length / 2)
    const rightKeys = range.keys.slice(mid)
    const rightStart = rightKeys[0]
    if (rightStart === undefined) return
    range.keys = range.keys.slice(0, mid)
    this.ranges.splice(i + 1, 0, { start: rightStart, keys: rightKeys })
  }
}

function insertSorted(list: string[], key: string): void {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const at = list[mid]
    if (at !== undefined && at < key) lo = mid + 1
    else hi = mid
  }
  if (list[lo] === key) return
  list.splice(lo, 0, key)
}
