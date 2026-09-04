import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import {
  benchStore,
  compareStores,
  nearestRankPercentile,
  postId,
  QUERY_SHAPES,
  relativeP50,
  renderComparisonTable,
  seedWorkload,
  summarizeLatencies,
  userId,
  validateSeed,
  WRITER_ID,
  type QueryShape,
  type ShapeRow,
} from '../src/bench'
import { MemoryStore } from '../src/memory-store'
import { PostgresStore } from '../src/postgres/store'

const TINY = { users: 6, followeesPerUser: 2, postsPerAuthor: 8 }

describe('latency stats', () => {
  it('uses nearest-rank on known vectors and rejects empty input', () => {
    const s = [1, 2, 3, 4, 5]
    expect(nearestRankPercentile(s, 0)).toBe(1)
    expect(nearestRankPercentile(s, 50)).toBe(3)
    expect(nearestRankPercentile(s, 95)).toBe(5)
    expect(nearestRankPercentile([7], 99)).toBe(7)
    expect(() => nearestRankPercentile([], 50)).toThrow(RangeError)
    expect(() => nearestRankPercentile([1], -1)).toThrow(RangeError)
    expect(() => nearestRankPercentile([1], 101)).toThrow(RangeError)
  })

  it('summarizes without mutating and derives ops/s from mean', () => {
    const samples = [400, 100, 200]
    expect(summarizeLatencies(samples)).toMatchObject({
      samples: 3,
      minNs: 100,
      maxNs: 400,
      meanNs: 233,
      p50Ns: 200,
      p95Ns: 400,
      opsPerSec: Math.round(1e9 / 233),
    })
    expect(samples).toEqual([400, 100, 200])
    expect(summarizeLatencies([0, 0]).opsPerSec).toBe(0)
    expect(() => summarizeLatencies([])).toThrow(RangeError)
  })
})

describe('workload', () => {
  it('rejects a follow-ring that would self-follow', () => {
    expect(() =>
      validateSeed({ users: 4, followeesPerUser: 4, postsPerAuthor: 1 }),
    ).toThrow(RangeError)
    expect(() =>
      validateSeed({ users: 4, followeesPerUser: 0, postsPerAuthor: 1 }),
    ).toThrow(RangeError)
  })

  it('builds a ring and keeps the writer off the reader feed', async () => {
    const store = new MemoryStore()
    const fixture = await seedWorkload(store, TINY)
    expect(fixture).toMatchObject({
      readerId: userId(0),
      authorId: userId(1),
      writerId: WRITER_ID,
      knownPostId: postId(1, 7),
    })
    expect(await store.following(userId(0))).toEqual([userId(1), userId(2)])
    expect(await store.following(userId(5))).toEqual([userId(0), userId(1)])
    expect(await store.feed(userId(0), { limit: 100 })).toHaveLength(16)
    expect(await store.postsByAuthor(WRITER_ID)).toEqual([])
    const newest = await store.getPost(fixture.knownPostId)
    expect(newest?.createdAt).toBe(fixture.cursor.createdAt)
  })
})

describe('benchStore', () => {
  it('records one row per shape after discarding warmup', async () => {
    const rows = await benchStore('memory', new MemoryStore(), {
      seed: TINY,
      iterations: 5,
      warmup: 2,
      pageSize: 5,
    })
    expect(rows.map((row) => row.shape)).toEqual([...QUERY_SHAPES])
    for (const row of rows) {
      expect(row.stats.samples).toBe(5)
      expect(row.stats.minNs).toBeGreaterThanOrEqual(0)
      expect(row.stats.p95Ns).toBeGreaterThanOrEqual(row.stats.p50Ns)
    }
  })

  it('times only measured iterations when the clock is injected', async () => {
    const ticks = [0n, 10n, 10n, 110n, 110n, 310n]
    let i = 0
    const nowNs = () => {
      const tick = ticks[i]
      i += 1
      return tick ?? BigInt(1000 + i)
    }
    const rows = await benchStore('fake', new MemoryStore(), {
      seed: { users: 3, followeesPerUser: 1, postsPerAuthor: 2 },
      iterations: 2,
      warmup: 1,
      nowNs,
    })
    expect(rows[0]?.stats).toMatchObject({
      samples: 2,
      minNs: 100,
      maxNs: 200,
      p50Ns: 100,
      meanNs: 150,
    })
  })

  it('keeps writer publishes out of the reader home feed', async () => {
    const store = new MemoryStore()
    await benchStore('memory', store, {
      seed: TINY,
      iterations: 3,
      warmup: 1,
    })
    const feed = await store.feed(userId(0), { limit: 100 })
    expect(feed.every((post) => post.authorId !== WRITER_ID)).toBe(true)
    expect(await store.postsByAuthor(WRITER_ID)).toHaveLength(4)
    await expect(
      benchStore('memory', new MemoryStore(), { iterations: 0 }),
    ).rejects.toThrow(RangeError)
  })
})

describe('comparison table', () => {
  it('ranks shapes, sorts markdown, and benches two backends', async () => {
    const rel = relativeP50([
      row('slow', 'point_get', 200),
      row('fast', 'point_get', 50),
      row('slow', 'home_feed', 400),
      row('fast', 'home_feed', 400),
    ])
    expect(rel.get('fast\tpoint_get')).toBe(1)
    expect(rel.get('slow\tpoint_get')).toBe(4)
    expect(rel.get('fast\thome_feed')).toBe(1)

    const md = renderComparisonTable([
      row('pg', 'publish', 80),
      row('memory', 'point_get', 10),
      row('pg', 'point_get', 40),
    ])
    expect(md.split('\n').slice(2)).toEqual([
      expect.stringContaining('| memory | point_get |'),
      expect.stringContaining('| pg | point_get |'),
      expect.stringContaining('| pg | publish |'),
    ])
    expect(md).toContain('| 4.00 |')

    const db = new PGlite()
    await db.waitReady
    const rows = await compareStores(
      [
        { name: 'memory', store: new MemoryStore() },
        { name: 'postgres', store: await PostgresStore.create(db) },
      ],
      { seed: TINY, iterations: 4, warmup: 1, pageSize: 5 },
    )
    await db.close()
    expect(rows).toHaveLength(QUERY_SHAPES.length * 2)
    const table = renderComparisonTable(rows)
    for (const shape of QUERY_SHAPES) {
      expect(table).toContain(`| memory | ${shape} |`)
      expect(table).toContain(`| postgres | ${shape} |`)
    }
  })
})

function row(backend: string, shape: QueryShape, p50Ns: number): ShapeRow {
  return {
    backend,
    shape,
    stats: {
      samples: 1,
      minNs: p50Ns,
      maxNs: p50Ns,
      meanNs: p50Ns,
      p50Ns,
      p95Ns: p50Ns,
      p99Ns: p50Ns,
      opsPerSec: p50Ns === 0 ? 0 : Math.round(1e9 / p50Ns),
    },
  }
}
