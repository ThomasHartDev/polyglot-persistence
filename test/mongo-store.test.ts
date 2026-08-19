import { describe, expect, it } from 'vitest'
import { DuplicateKeyError, MemoryMongo } from '../src/mongo/memory'
import {
  INDEXES,
  MongoStore,
  keysetFilter,
  type FollowDoc,
  type PostDoc,
  type UserDoc,
} from '../src/mongo/store'
import { defineStoreContract } from './contract'

defineStoreContract('mongo', async () => MongoStore.create(new MemoryMongo()))

describe('mongo document shape', () => {
  it('embeds following on the user and references posts plus inbound edges', async () => {
    const db = new MemoryMongo()
    const store = await MongoStore.create(db)
    await store.createUser({ id: 'ada', handle: 'ada' }, 1)
    await store.createUser({ id: 'bob', handle: 'bob' }, 1)
    await store.follow('ada', 'bob')
    await store.publish({ id: 'p1', authorId: 'bob', body: 'hi' }, 4)

    const ada = await db.collection<UserDoc>('users').findOne({ _id: 'ada' })
    const bob = await db.collection<UserDoc>('users').findOne({ _id: 'bob' })
    expect(ada).toEqual({ _id: 'ada', handle: 'ada', createdAt: 1, following: ['bob'] })
    expect(ada).not.toHaveProperty('posts')
    expect(bob).toEqual({ _id: 'bob', handle: 'bob', createdAt: 1, following: [] })
    expect(await db.collection<PostDoc>('posts').find({})).toEqual([
      { _id: 'p1', authorId: 'bob', body: 'hi', createdAt: 4 },
    ])
    expect(await db.collection<FollowDoc>('follows').find({})).toEqual([
      { _id: 'ada\x1fbob', followerId: 'ada', followeeId: 'bob' },
    ])
    expect(await db.collection<PostDoc>('posts').find({ authorId: { $in: [] } })).toEqual([])
  })

  it('repairs a missing embedded follow with $addToSet on a duplicate edge', async () => {
    const db = new MemoryMongo()
    const store = await MongoStore.create(db)
    await store.createUser({ id: 'ada', handle: 'ada' }, 1)
    await store.createUser({ id: 'bob', handle: 'bob' }, 1)
    await db.collection<FollowDoc>('follows').insertOne({
      _id: 'ada\x1fbob',
      followerId: 'ada',
      followeeId: 'bob',
    })
    await store.follow('ada', 'bob')
    expect(await store.following('ada')).toEqual(['bob'])
    expect(await store.isFollowing('ada', 'bob')).toBe(true)
  })

  it('rejects a duplicate handle at the unique index (E11000)', async () => {
    const db = new MemoryMongo()
    await MongoStore.migrate(db)
    const users = db.collection<UserDoc>('users')
    await users.insertOne({ _id: 'u1', handle: 'ada', createdAt: 1, following: [] })
    await expect(
      users.insertOne({ _id: 'u2', handle: 'ada', createdAt: 2, following: [] }),
    ).rejects.toMatchObject({
      constructor: DuplicateKeyError,
      code: 11000,
      keyPattern: { handle: 1 },
    })
    expect(INDEXES.map((idx) => idx.name)).toEqual([
      'users_handle_uidx', 'posts_author_timeline_idx', 'follows_edge_uidx', 'follows_inbound_idx',
    ])
  })

  it('pages equal timestamps with a compound $or keyset', async () => {
    const db = new MemoryMongo()
    const store = await MongoStore.create(db)
    await store.createUser({ id: 'ada', handle: 'ada' }, 1)
    await store.createUser({ id: 'bob', handle: 'bob' }, 1)
    await store.follow('ada', 'bob')
    await store.publish({ id: 'p1', authorId: 'bob', body: 'older-id' }, 10)
    await store.publish({ id: 'p2', authorId: 'bob', body: 'newer-id' }, 10)
    await store.publish({ id: 'p3', authorId: 'bob', body: 'earlier' }, 4)

    const posts = db.collection<PostDoc>('posts')
    const first = await posts.find(
      { authorId: { $in: ['bob'] }, ...keysetFilter() },
      { sort: { createdAt: -1, _id: -1 }, limit: 1 },
    )
    expect(first.map((row) => row._id)).toEqual(['p2'])
    const rest = await posts.find(
      { authorId: { $in: ['bob'] }, ...keysetFilter({ createdAt: 10, id: 'p2' }) },
      { sort: { createdAt: -1, _id: -1 }, limit: 2 },
    )
    expect(rest.map((row) => row._id)).toEqual(['p1', 'p3'])
  })
})
