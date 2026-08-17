import { describe, expect, it } from 'vitest'
import { MemoryRedis, RedisStore } from '../src/redis/store'
import { defineStoreContract } from './contract'

defineStoreContract('redis', () => RedisStore.attach(new MemoryRedis()))

describe('redis data structures and expiry', () => {
  it('stores users as hashes and reserves handles with SET NX', async () => {
    const redis = new MemoryRedis()
    const store = RedisStore.attach(redis)
    await store.createUser({ id: 'ada', handle: 'ada' }, 10)

    expect(await redis.hgetall('u:ada')).toEqual({
      id: 'ada',
      handle: 'ada',
      createdAt: '10',
    })
    expect(await redis.get('h:ada')).toBe('ada')
    await expect(store.createUser({ id: 'ada2', handle: 'ADA' })).rejects.toMatchObject({
      code: 'handle_taken',
    })
    expect(await redis.hgetall('u:ada2')).toEqual({})
    expect(await store.getUser('ada')).toEqual({
      id: 'ada',
      handle: 'ada',
      createdAt: 10,
    })
  })

  it('models follows as two sets and the author timeline as a scored zset', async () => {
    const redis = new MemoryRedis()
    const store = RedisStore.attach(redis)
    await store.createUser({ id: 'ada', handle: 'ada' }, 1)
    await store.createUser({ id: 'bob', handle: 'bob' }, 1)
    await store.follow('ada', 'bob')
    await store.publish({ id: 'p1', authorId: 'bob', body: 'older' }, 4)
    await store.publish({ id: 'p2', authorId: 'bob', body: 'newer' }, 10)

    expect(await redis.smembers('fg:ada')).toEqual(['bob'])
    expect(await redis.smembers('fr:bob')).toEqual(['ada'])
    expect(await redis.zrevrangebyscore('tl:bob', Infinity, -Infinity)).toEqual([
      { member: 'p2', score: 10 },
      { member: 'p1', score: 4 },
    ])
    expect(await redis.zcard('tl:bob')).toBe(2)
  })

  it('orders equal scores by member desc, matching ZREVRANGE', async () => {
    const redis = new MemoryRedis()
    const store = RedisStore.attach(redis)
    await store.createUser({ id: 'bob', handle: 'bob' }, 1)
    await store.publish({ id: 'p1', authorId: 'bob', body: 'a' }, 10)
    await store.publish({ id: 'p2', authorId: 'bob', body: 'b' }, 10)
    expect((await store.postsByAuthor('bob')).map((p) => p.id)).toEqual(['p2', 'p1'])
  })

  it('expires a post hash while the zset member lingers until the next read', async () => {
    const clock = { now: 1_000 }
    const redis = new MemoryRedis(() => clock.now)
    const store = RedisStore.attach(redis)
    await store.createUser({ id: 'ada', handle: 'ada' }, 1)
    await store.createUser({ id: 'bob', handle: 'bob' }, 1)
    await store.follow('ada', 'bob')
    await store.publish({ id: 'p1', authorId: 'bob', body: 'ephemeral' }, 5)

    expect(await store.expirePost('p1', 50)).toBe(true)
    expect(await redis.pttl('p:p1')).toBe(50)
    expect(await store.getPost('p1')).toMatchObject({ id: 'p1' })
    expect(await redis.zcard('tl:bob')).toBe(1)

    clock.now = 1_050
    expect(await store.getPost('p1')).toBeNull()
    expect(await redis.pttl('p:p1')).toBe(-2)
    expect(await redis.zcard('tl:bob')).toBe(1)
    expect(await store.feed('ada')).toEqual([])
    expect(await redis.zcard('tl:bob')).toBe(0)
  })

  it('lets a post id be reused after TTL, unlike a relational primary key', async () => {
    const clock = { now: 1_000 }
    const redis = new MemoryRedis(() => clock.now)
    const store = RedisStore.attach(redis)
    await store.createUser({ id: 'bob', handle: 'bob' }, 1)
    await store.publish({ id: 'p1', authorId: 'bob', body: 'first' }, 5)
    await store.expirePost('p1', 10)
    clock.now = 1_020

    const again = await store.publish({ id: 'p1', authorId: 'bob', body: 'second' }, 9)
    expect(again).toEqual({ id: 'p1', authorId: 'bob', body: 'second', createdAt: 9 })
    expect(await redis.zcard('tl:bob')).toBe(1)
    expect(await store.postsByAuthor('bob')).toEqual([again])
    expect(await store.expirePost('missing', 50)).toBe(false)
    expect(await store.expirePost('p1', 0)).toBe(false)
  })
})
