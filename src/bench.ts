import type { FeedCursor, PostId, UserId } from './domain'
import type { ActivityStore } from './store'

export const QUERY_SHAPES = [
  'point_get',
  'author_timeline',
  'home_feed',
  'keyset_page',
  'publish',
] as const

export type QueryShape = (typeof QUERY_SHAPES)[number]
export const WRITER_ID: UserId = 'writer'

export interface SeedSpec {
  users: number
  followeesPerUser: number
  postsPerAuthor: number
}

export const DEFAULT_SEED: SeedSpec = {
  users: 12,
  followeesPerUser: 4,
  postsPerAuthor: 16,
}

export interface LatencyStats {
  samples: number
  minNs: number
  maxNs: number
  meanNs: number
  p50Ns: number
  p95Ns: number
  p99Ns: number
  opsPerSec: number
}

export interface ShapeRow {
  backend: string
  shape: QueryShape
  stats: LatencyStats
}

export interface BenchOptions {
  seed?: SeedSpec
  iterations?: number
  warmup?: number
  pageSize?: number
  nowNs?: () => bigint
}

export interface BenchFixture {
  readerId: UserId
  authorId: UserId
  writerId: UserId
  knownPostId: PostId
  cursor: FeedCursor
}

export function userId(index: number): UserId {
  return `u${index}`
}

export function postId(authorIndex: number, seq: number): PostId {
  return `p${authorIndex}_${seq}`
}

export function validateSeed(spec: SeedSpec): SeedSpec {
  requireInt(spec.users, 2, 'users')
  requireInt(spec.followeesPerUser, 1, 'followeesPerUser')
  requireInt(spec.postsPerAuthor, 1, 'postsPerAuthor')
  if (spec.followeesPerUser >= spec.users) {
    throw new RangeError('followeesPerUser')
  }
  return spec
}

export function nearestRankPercentile(
  sorted: readonly number[],
  p: number,
): number {
  if (sorted.length === 0) throw new RangeError('empty sample')
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new RangeError('percentile')
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  )
  return at(sorted, index)
}

export function summarizeLatencies(samples: readonly number[]): LatencyStats {
  if (samples.length === 0) throw new RangeError('empty sample')
  const sorted = [...samples].sort((a, b) => a - b)
  const mean = Math.round(samples.reduce((sum, n) => sum + n, 0) / samples.length)
  return {
    samples: samples.length,
    minNs: at(sorted, 0),
    maxNs: at(sorted, sorted.length - 1),
    meanNs: mean,
    p50Ns: nearestRankPercentile(sorted, 50),
    p95Ns: nearestRankPercentile(sorted, 95),
    p99Ns: nearestRankPercentile(sorted, 99),
    opsPerSec: mean <= 0 ? 0 : Math.round(1e9 / mean),
  }
}

export async function seedWorkload(
  store: ActivityStore,
  spec: SeedSpec = DEFAULT_SEED,
): Promise<BenchFixture> {
  const seed = validateSeed(spec)
  for (let i = 0; i < seed.users; i++) {
    const id = userId(i)
    await store.createUser({ id, handle: id }, 1)
  }
  await store.createUser({ id: WRITER_ID, handle: WRITER_ID }, 1)
  for (let i = 0; i < seed.users; i++) {
    for (let step = 1; step <= seed.followeesPerUser; step++) {
      await store.follow(userId(i), userId((i + step) % seed.users))
    }
  }
  const lastSeq = seed.postsPerAuthor - 1
  for (let i = 0; i < seed.users; i++) {
    for (let seq = 0; seq < seed.postsPerAuthor; seq++) {
      await store.publish(
        { id: postId(i, seq), authorId: userId(i), body: 'bench' },
        postTime(i, seq, seed.users),
      )
    }
  }
  const knownPostId = postId(1, lastSeq)
  return {
    readerId: userId(0),
    authorId: userId(1),
    writerId: WRITER_ID,
    knownPostId,
    cursor: { createdAt: postTime(1, lastSeq, seed.users), id: knownPostId },
  }
}

export async function benchStore(
  backend: string,
  store: ActivityStore,
  options: BenchOptions = {},
): Promise<ShapeRow[]> {
  const iterations = requireInt(options.iterations ?? 32, 1, 'iterations')
  const warmup = options.warmup ?? 8
  const pageSize = requireInt(options.pageSize ?? 20, 1, 'pageSize')
  if (!Number.isInteger(warmup) || warmup < 0) throw new RangeError('warmup')
  const nowNs = options.nowNs ?? defaultNowNs
  const fixture = await seedWorkload(store, options.seed ?? DEFAULT_SEED)
  const ops = shapeOps(store, fixture, pageSize)
  const rows: ShapeRow[] = []
  let writes = 0
  for (const shape of QUERY_SHAPES) {
    const samples: number[] = []
    for (let i = 0; i < warmup + iterations; i++) {
      const ns = await timeOp(nowNs, () =>
        ops[shape](shape === 'publish' ? writes++ : i),
      )
      if (i >= warmup) samples.push(ns)
    }
    rows.push({ backend, shape, stats: summarizeLatencies(samples) })
  }
  return rows
}

export async function compareStores(
  stores: ReadonlyArray<{ name: string; store: ActivityStore }>,
  options: BenchOptions = {},
): Promise<ShapeRow[]> {
  const rows: ShapeRow[] = []
  for (const entry of stores) {
    rows.push(...(await benchStore(entry.name, entry.store, options)))
  }
  return rows
}

export function relativeP50(rows: readonly ShapeRow[]): Map<string, number> {
  const best = new Map<QueryShape, number>()
  for (const row of rows) {
    const current = best.get(row.shape)
    if (current === undefined || row.stats.p50Ns < current) {
      best.set(row.shape, row.stats.p50Ns)
    }
  }
  const out = new Map<string, number>()
  for (const row of rows) {
    const floor = Math.max(1, best.get(row.shape) ?? 1)
    out.set(rowKey(row), row.stats.p50Ns / floor)
  }
  return out
}

export function renderComparisonTable(rows: readonly ShapeRow[]): string {
  const rel = relativeP50(rows)
  const ordered = [...rows].sort((a, b) => {
    const shape = QUERY_SHAPES.indexOf(a.shape) - QUERY_SHAPES.indexOf(b.shape)
    return shape !== 0 ? shape : a.backend.localeCompare(b.backend)
  })
  const lines = [
    '| backend | shape | n | p50_us | p95_us | p99_us | mean_us | ops_s | rel_p50 |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const row of ordered) {
    const s = row.stats
    const ratio = (rel.get(rowKey(row)) ?? 1).toFixed(2)
    lines.push(
      `| ${row.backend} | ${row.shape} | ${s.samples} | ${us(s.p50Ns)} | ${us(s.p95Ns)} | ${us(s.p99Ns)} | ${us(s.meanNs)} | ${s.opsPerSec} | ${ratio} |`,
    )
  }
  return lines.join('\n')
}

function rowKey(row: ShapeRow): string {
  return `${row.backend}\t${row.shape}`
}

function us(ns: number): string {
  return (ns / 1000).toFixed(1)
}

function postTime(authorIndex: number, seq: number, userCount: number): number {
  return seq * userCount + authorIndex + 1
}

function requireInt(n: number, min: number, label: string): number {
  if (!Number.isInteger(n) || n < min) throw new RangeError(label)
  return n
}

function at(sorted: readonly number[], index: number): number {
  const value = sorted[index]
  if (value === undefined) throw new RangeError('index')
  return value
}

function defaultNowNs(): bigint {
  const fn = (globalThis as { process?: { hrtime?: { bigint?: () => bigint } } }).process
    ?.hrtime?.bigint
  if (typeof fn !== 'function') throw new Error('hrtime.bigint required')
  return fn()
}

async function timeOp(
  nowNs: () => bigint,
  op: () => Promise<unknown>,
): Promise<number> {
  const start = nowNs()
  await op()
  const elapsed = nowNs() - start
  if (elapsed <= 0n) return 0
  if (elapsed > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  return Number(elapsed)
}

function shapeOps(
  store: ActivityStore,
  fixture: BenchFixture,
  pageSize: number,
): Record<QueryShape, (i: number) => Promise<unknown>> {
  return {
    point_get: () => store.getPost(fixture.knownPostId),
    author_timeline: () =>
      store.postsByAuthor(fixture.authorId, { limit: pageSize }),
    home_feed: () => store.feed(fixture.readerId, { limit: pageSize }),
    keyset_page: () =>
      store.feed(fixture.readerId, { limit: pageSize, before: fixture.cursor }),
    publish: (i) =>
      store.publish(
        { id: `w${i}`, authorId: fixture.writerId, body: 'bench' },
        1_000_000 + i,
      ),
  }
}
