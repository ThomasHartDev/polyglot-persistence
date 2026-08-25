import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CockroachStore,
  CRDB_HASH_STATEMENTS,
  Keyspace,
  SERIALIZATION_FAILURE,
  hashShardedIndexKey,
  hashShardedKey,
  layoutHash,
  orderedIndexKey,
  serialKey,
  shouldHashShard,
  uuidKey,
  withSerializableRetry,
} from '../src/cockroach/store'
import { defineStoreContract } from './contract'

const db = new PGlite()

beforeAll(async () => {
  await db.waitReady
  await CockroachStore.migrate(db)
}, 30_000)

afterAll(async () => {
  await db.close()
})

defineStoreContract('cockroach', async () => {
  await db.query('TRUNCATE TABLE users CASCADE')
  return CockroachStore.attach(db)
})

describe('cockroach key layout', () => {
  it('hash-shards sequential point lookups and monotonic indexes, not prefix scans', () => {
    expect(shouldHashShard('point', true)).toBe(true)
    expect(shouldHashShard('point', false)).toBe(false)
    expect(shouldHashShard('prefix-scan', true)).toBe(false)
    expect(shouldHashShard('monotonic-append', false)).toBe(true)
    expect(layoutHash('usersPk')).toBe(true)
    expect(layoutHash('postsPk')).toBe(true)
    expect(layoutHash('followsByFollower')).toBe(false)
    expect(layoutHash('postsByAuthor')).toBe(false)
    expect(layoutHash('postsByCreatedAt')).toBe(true)
  })

  it('declares HASH alters for users and posts PKs and the global created_at index', () => {
    const sql = CRDB_HASH_STATEMENTS.join('\n')
    expect(sql).toContain('ALTER TABLE users ALTER PRIMARY KEY')
    expect(sql).toContain('ALTER TABLE posts ALTER PRIMARY KEY')
    expect(sql).toContain('posts_created_at_hash_idx')
    expect(sql).not.toContain('ALTER TABLE follows')
    for (const statement of CRDB_HASH_STATEMENTS) {
      expect(statement).toMatch(/USING HASH WITH \(bucket_count = \d+\)/)
    }
  })
})

describe('cockroach ranges and hotspots', () => {
  it('treats an empty key list as no hotspot', () => {
    expect(new Keyspace(4).hottestShare([])).toBe(0)
  })

  it('rejects a non-power-of-two bucket count', () => {
    expect(() => hashShardedKey('k', 3)).toThrow(RangeError)
    expect(() => new Keyspace(1)).toThrow(RangeError)
  })

  it('pins sequential primary keys onto the rightmost range', () => {
    const space = new Keyspace(8)
    const keys = Array.from({ length: 40 }, (_, i) => serialKey(i))
    for (const key of keys) space.insert(key)
    expect(space.rangeCount()).toBeGreaterThan(1)
    expect(space.hottestShare(keys.slice(-8))).toBe(1)
  })

  it('spreads hash-sharded and uuid keys across ranges', () => {
    const hashed = new Keyspace(8)
    const hashedKeys = Array.from({ length: 64 }, (_, i) => hashShardedKey(uuidKey(i), 16))
    for (const key of hashedKeys) hashed.insert(key)
    expect(hashed.hottestShare(hashedKeys.slice(-16))).toBeLessThan(0.5)

    const uuids = new Keyspace(8)
    const uuidKeys = Array.from({ length: 64 }, (_, i) => uuidKey(i))
    for (const key of uuidKeys) uuids.insert(key)
    expect(uuids.hottestShare(uuidKeys.slice(-16))).toBeLessThan(0.5)
  })

  it('keeps one author timeline on a contiguous span of ranges', () => {
    const space = new Keyspace(8)
    for (let t = 0; t < 32; t++) space.insert(orderedIndexKey('ada', t, `p${t}`))
    for (let t = 0; t < 32; t++) space.insert(orderedIndexKey('bob', t, `q${t}`))
    const ada = uniqueSorted(
      Array.from({ length: 32 }, (_, t) => space.rangeIndex(orderedIndexKey('ada', t, `p${t}`))),
    )
    const bob = uniqueSorted(
      Array.from({ length: 32 }, (_, t) => space.rangeIndex(orderedIndexKey('bob', t, `q${t}`))),
    )
    expect(contiguous(ada)).toBe(true)
    expect(contiguous(bob)).toBe(true)
    expect(Math.max(...ada)).toBeLessThanOrEqual(Math.min(...bob))
  })

  it('scatters a hashed created_at index so monotonic time does not hotspot', () => {
    const space = new Keyspace(8)
    const keys = Array.from({ length: 48 }, (_, i) => hashShardedIndexKey(i, `p${i}`, 8))
    for (const key of keys) space.insert(key)
    expect(space.rangeCount()).toBeGreaterThan(2)
    const ranges = new Set(keys.map((key) => space.rangeIndex(key)))
    expect(ranges.size).toBeGreaterThan(2)
  })
})

describe('serializable retry', () => {
  it('retries 40001 and then returns', async () => {
    let n = 0
    const value = await withSerializableRetry(async () => {
      n += 1
      if (n < 3) throw Object.assign(new Error('restart transaction'), { code: SERIALIZATION_FAILURE })
      return 7
    }, { attempts: 5 })
    expect(value).toBe(7)
    expect(n).toBe(3)
  })

  it('does not retry a constraint error', async () => {
    let n = 0
    await expect(
      withSerializableRetry(async () => {
        n += 1
        throw Object.assign(new Error('unique'), { code: '23505' })
      }, { attempts: 5 }),
    ).rejects.toMatchObject({ code: '23505' })
    expect(n).toBe(1)
  })

  it('retries a 40001 from the sql client on publish', async () => {
    await db.query('TRUNCATE TABLE users CASCADE')
    let fails = 1
    const sql = {
      query: async <T = Record<string, unknown>>(query: string, params?: unknown[]) => {
        if (query.includes('INSERT INTO posts') && fails > 0) {
          fails -= 1
          throw Object.assign(new Error('restart transaction'), { code: SERIALIZATION_FAILURE })
        }
        return db.query<T>(query, params)
      },
    }
    const store = CockroachStore.attach(sql, { attempts: 4 })
    await store.createUser({ id: 'ada', handle: 'ada' }, 1)
    const post = await store.publish({ id: 'p1', authorId: 'ada', body: 'retry' }, 2)
    expect(post.id).toBe('p1')
    expect(fails).toBe(0)
  })

  it('stops after the attempt budget', async () => {
    let n = 0
    await expect(
      withSerializableRetry(async () => {
        n += 1
        throw Object.assign(new Error('restart transaction'), { code: SERIALIZATION_FAILURE })
      }, { attempts: 3 }),
    ).rejects.toMatchObject({ code: SERIALIZATION_FAILURE })
    expect(n).toBe(3)
  })
})

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b)
}

function contiguous(indexes: number[]): boolean {
  if (indexes.length <= 1) return true
  const last = indexes[indexes.length - 1]
  const first = indexes[0]
  if (first === undefined || last === undefined) return false
  return last - first === indexes.length - 1
}
