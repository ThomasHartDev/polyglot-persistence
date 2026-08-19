import {
  normalizeBody,
  normalizeHandle,
  normalizeId,
  pageLimit,
  StoreError,
  tryNormalizeHandle,
  tryNormalizeId,
  type FeedCursor,
  type Page,
  type Post,
  type PostId,
  type User,
  type UserId,
} from '../domain'
import type { ActivityStore, CreateUserInput, PublishInput } from '../store'
import { type Filter, type MongoCollection, type MongoDb } from './memory'

export { DuplicateKeyError, MemoryMongo } from './memory'
export type { MongoCollection, MongoDb } from './memory'

export interface UserDoc {
  _id: string
  handle: string
  createdAt: number
  following: UserId[]
}

export interface PostDoc {
  _id: string
  authorId: UserId
  body: string
  createdAt: number
}

export interface FollowDoc {
  _id: string
  followerId: UserId
  followeeId: UserId
}

export const INDEXES = [
  { collection: 'users', key: { handle: 1 }, unique: true, name: 'users_handle_uidx' },
  { collection: 'posts', key: { authorId: 1, createdAt: -1, _id: -1 }, name: 'posts_author_timeline_idx' },
  { collection: 'follows', key: { followerId: 1, followeeId: 1 }, unique: true, name: 'follows_edge_uidx' },
  { collection: 'follows', key: { followeeId: 1 }, name: 'follows_inbound_idx' },
] as const

const NEWEST = { createdAt: -1, _id: -1 } as const

export function keysetFilter(cursor?: FeedCursor): Filter {
  if (!cursor) return {}
  return {
    $or: [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }],
  }
}

export class MongoStore implements ActivityStore {
  private readonly users: MongoCollection<UserDoc>
  private readonly posts: MongoCollection<PostDoc>
  private readonly follows: MongoCollection<FollowDoc>

  private constructor(db: MongoDb) {
    this.users = db.collection('users')
    this.posts = db.collection('posts')
    this.follows = db.collection('follows')
  }

  static async migrate(db: MongoDb): Promise<void> {
    for (const idx of INDEXES) {
      await db.collection(idx.collection).createIndex(idx.key, {
        unique: 'unique' in idx && idx.unique,
        name: idx.name,
      })
    }
  }

  static async create(db: MongoDb): Promise<MongoStore> {
    await MongoStore.migrate(db)
    return new MongoStore(db)
  }

  async createUser(input: CreateUserInput, now = Date.now()): Promise<User> {
    const id = normalizeId(input.id)
    const handle = normalizeHandle(input.handle)
    const doc: UserDoc = { _id: id, handle, createdAt: now, following: [] }
    try {
      await this.users.insertOne(doc)
    } catch (err) {
      throwMapped(err, 'user')
    }
    return toUser(doc)
  }

  async getUser(id: UserId): Promise<User | null> {
    const key = tryNormalizeId(id)
    if (!key) return null
    const doc = await this.users.findOne({ _id: key })
    return doc ? toUser(doc) : null
  }

  async getUserByHandle(handle: string): Promise<User | null> {
    const key = tryNormalizeHandle(handle)
    if (!key) return null
    const doc = await this.users.findOne({ handle: key })
    return doc ? toUser(doc) : null
  }

  async follow(followerId: UserId, followeeId: UserId): Promise<void> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    if (from === to) throw new StoreError('self_follow')
    try {
      await this.follows.insertOne({ _id: `${from}\x1f${to}`, followerId: from, followeeId: to })
    } catch (err) {
      if (!isDuplicateKey(err)) throw err
    }
    // Dual-write: following[] is the feed $in path; follows is inbound reverse lookup.
    await this.users.updateOne({ _id: from }, { $addToSet: { following: to } })
  }

  async unfollow(followerId: UserId, followeeId: UserId): Promise<void> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    await this.follows.deleteOne({ followerId: from, followeeId: to })
    await this.users.updateOne({ _id: from }, { $pull: { following: to } })
  }

  async isFollowing(followerId: UserId, followeeId: UserId): Promise<boolean> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    return (await this.follows.findOne({ followerId: from, followeeId: to })) !== null
  }

  async following(userId: UserId): Promise<UserId[]> {
    const id = await this.requireUser(userId)
    const doc = await this.users.findOne({ _id: id })
    return [...(doc?.following ?? [])].sort()
  }

  async followers(userId: UserId): Promise<UserId[]> {
    const id = await this.requireUser(userId)
    const rows = await this.follows.find({ followeeId: id })
    return rows.map((row) => row.followerId).sort()
  }

  async publish(input: PublishInput, now = Date.now()): Promise<Post> {
    const id = normalizeId(input.id)
    const authorId = await this.requireUser(input.authorId)
    const body = normalizeBody(input.body)
    const doc: PostDoc = { _id: id, authorId, body, createdAt: now }
    try {
      await this.posts.insertOne(doc)
    } catch (err) {
      throwMapped(err, 'post')
    }
    return toPost(doc)
  }

  async getPost(id: PostId): Promise<Post | null> {
    const key = tryNormalizeId(id)
    if (!key) return null
    const doc = await this.posts.findOne({ _id: key })
    return doc ? toPost(doc) : null
  }

  async postsByAuthor(authorId: UserId, page?: Page): Promise<Post[]> {
    const id = await this.requireUser(authorId)
    return this.newest({ authorId: id }, page)
  }

  async feed(userId: UserId, page?: Page): Promise<Post[]> {
    const id = await this.requireUser(userId)
    const user = await this.users.findOne({ _id: id })
    return this.newest({ authorId: { $in: user?.following ?? [] } }, page)
  }

  private async newest(filter: Filter, page?: Page): Promise<Post[]> {
    const rows = await this.posts.find(
      { ...filter, ...keysetFilter(page?.before) },
      { sort: { ...NEWEST }, limit: pageLimit(page) },
    )
    return rows.map(toPost)
  }

  private async requireUser(id: UserId): Promise<UserId> {
    const key = tryNormalizeId(id)
    if (!key) throw new StoreError('user_not_found')
    if (!(await this.users.findOne({ _id: key }))) throw new StoreError('user_not_found')
    return key
  }
}

function toUser(doc: UserDoc): User {
  return { id: doc._id, handle: doc.handle, createdAt: doc.createdAt }
}

function toPost(doc: PostDoc): Post {
  return { id: doc._id, authorId: doc.authorId, body: doc.body, createdAt: doc.createdAt }
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 11000
}

function keyPatternOf(err: unknown): Record<string, unknown> {
  if (typeof err !== 'object' || err === null || !('keyPattern' in err)) return {}
  const value = (err as { keyPattern: unknown }).keyPattern
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function throwMapped(err: unknown, kind: 'user' | 'post'): never {
  if (isDuplicateKey(err)) {
    if (kind === 'user' && 'handle' in keyPatternOf(err)) throw new StoreError('handle_taken')
    throw new StoreError(kind === 'user' ? 'user_exists' : 'post_exists')
  }
  throw err
}
