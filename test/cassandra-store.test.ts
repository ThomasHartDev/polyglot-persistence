import { describe, expect, it } from 'vitest'
import {
  CassandraStore,
  InvalidQueryError,
  MemoryCassandra,
  TABLES,
  toCreateCql,
} from '../src/cassandra/store'
import { defineStoreContract } from './contract'

defineStoreContract('cassandra', () => CassandraStore.attach(new MemoryCassandra()))

describe('cassandra query-first tables', () => {
  it('emits compound partition and DESC clustering CQL for the author timeline', () => {
    const cql = toCreateCql(TABLES.postsByAuthor)
    expect(cql).toContain('PRIMARY KEY ((author_id), created_at, post_id)')
    expect(cql).toContain('CLUSTERING ORDER BY (created_at DESC, post_id DESC)')
    expect(toCreateCql(TABLES.usersByHandle)).toContain('PRIMARY KEY (handle)')
    expect(toCreateCql(TABLES.followingByUser)).toContain(
      'PRIMARY KEY ((follower_id), followee_id)',
    )
  })

  it('puts each author in their own partition, clustered newest-first', async () => {
    const ks = new MemoryCassandra()
    const store = CassandraStore.attach(ks)
    await store.createUser({ id: 'ada', handle: 'ada' }, 1)
    await store.createUser({ id: 'bob', handle: 'bob' }, 1)
    await store.publish({ id: 'p1', authorId: 'bob', body: 'oldest' }, 1)
    await store.publish({ id: 'p3', authorId: 'bob', body: 'tie-hi' }, 10)
    await store.publish({ id: 'p2', authorId: 'bob', body: 'tie-lo' }, 10)
    await store.publish({ id: 'a1', authorId: 'ada', body: 'ada' }, 9)

    expect(ks.partitionCount('posts_by_author')).toBe(2)
    expect(ks.select('posts_by_author', { eq: { author_id: 'bob' } }).map((row) => row.post_id)).toEqual([
      'p3',
      'p2',
      'p1',
    ])
    expect(ks.select('posts_by_author', { eq: { author_id: 'ada' } }).map((row) => row.post_id)).toEqual(['a1'])
  })

  it('rejects a clustering-only read and a non-key restriction', () => {
    const ks = new MemoryCassandra()
    expect(() =>
      ks.select('posts_by_author', { eq: { post_id: 'p1' } }),
    ).toThrow(InvalidQueryError)
    expect(() => ks.select('posts_by_author', { eq: { body: 'x' } })).toThrow(
      /cannot restrict body/,
    )
  })

  it('uses IF NOT EXISTS on the handle partition and rolls back users_by_id', async () => {
    const ks = new MemoryCassandra()
    const store = CassandraStore.attach(ks)
    await store.createUser({ id: 'u1', handle: 'ada' }, 1)
    await expect(store.createUser({ id: 'u2', handle: 'ADA' })).rejects.toMatchObject({
      code: 'handle_taken',
    })
    expect(ks.select('users_by_id', { eq: { user_id: 'u2' } })).toEqual([])
    expect(ks.partitionCount('users_by_handle')).toBe(1)
    expect(
      ks.insert('users_by_handle', { handle: 'ada', user_id: 'x', created_at: 0 }, {
        ifNotExists: true,
      }).applied,
    ).toBe(false)
  })

  it('pages a partition with a clustering tuple bound, not a table scan', async () => {
    const ks = new MemoryCassandra()
    const store = CassandraStore.attach(ks)
    await store.createUser({ id: 'bob', handle: 'bob' }, 1)
    await store.publish({ id: 'p1', authorId: 'bob', body: 'older-id' }, 10)
    await store.publish({ id: 'p2', authorId: 'bob', body: 'newer-id' }, 10)
    await store.publish({ id: 'p3', authorId: 'bob', body: 'earlier' }, 4)

    const rest = ks
      .select('posts_by_author', {
        eq: { author_id: 'bob' },
        clusteringLt: { created_at: 10, post_id: 'p2' },
        limit: 2,
      })
      .map((row) => row.post_id)
    expect(rest).toEqual(['p1', 'p3'])
  })

})
