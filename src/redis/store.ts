import {
  comparePosts,
  isBeforeCursor,
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
import type { RedisCommands } from './memory'

export { MemoryRedis, type RedisCommands } from './memory'

const kUser = (id: string) => `u:${id}`
const kHandle = (handle: string) => `h:${handle}`
const kPost = (id: string) => `p:${id}`
const kTimeline = (authorId: string) => `tl:${authorId}`
const kFollowing = (id: string) => `fg:${id}`
const kFollowers = (id: string) => `fr:${id}`

export class RedisStore implements ActivityStore {
  private constructor(private readonly redis: RedisCommands) {}

  static attach(redis: RedisCommands): RedisStore {
    return new RedisStore(redis)
  }

  async createUser(input: CreateUserInput, now = Date.now()): Promise<User> {
    const id = normalizeId(input.id)
    const handle = normalizeHandle(input.handle)
    if (!(await this.redis.hsetnx(kUser(id), 'id', id))) {
      throw new StoreError('user_exists')
    }
    if (!(await this.redis.set(kHandle(handle), id, { nx: true }))) {
      await this.redis.del(kUser(id))
      throw new StoreError('handle_taken')
    }
    await this.redis.hset(kUser(id), { handle, createdAt: String(now) })
    return { id, handle, createdAt: now }
  }

  async getUser(id: UserId): Promise<User | null> {
    const key = tryNormalizeId(id)
    return key ? readUser(await this.redis.hgetall(kUser(key))) : null
  }

  async getUserByHandle(handle: string): Promise<User | null> {
    const key = tryNormalizeHandle(handle)
    if (!key) return null
    const id = await this.redis.get(kHandle(key))
    return id ? this.getUser(id) : null
  }

  async follow(followerId: UserId, followeeId: UserId): Promise<void> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    if (from === to) throw new StoreError('self_follow')
    await this.redis.sadd(kFollowing(from), to)
    await this.redis.sadd(kFollowers(to), from)
  }

  async unfollow(followerId: UserId, followeeId: UserId): Promise<void> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    await this.redis.srem(kFollowing(from), to)
    await this.redis.srem(kFollowers(to), from)
  }

  async isFollowing(followerId: UserId, followeeId: UserId): Promise<boolean> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    return this.redis.sismember(kFollowing(from), to)
  }

  async following(userId: UserId): Promise<UserId[]> {
    const id = await this.requireUser(userId)
    return (await this.redis.smembers(kFollowing(id))).sort()
  }

  async followers(userId: UserId): Promise<UserId[]> {
    const id = await this.requireUser(userId)
    return (await this.redis.smembers(kFollowers(id))).sort()
  }

  async publish(input: PublishInput, now = Date.now()): Promise<Post> {
    const id = normalizeId(input.id)
    const authorId = await this.requireUser(input.authorId)
    const body = normalizeBody(input.body)
    if (!(await this.redis.hsetnx(kPost(id), 'id', id))) {
      throw new StoreError('post_exists')
    }
    await this.redis.hset(kPost(id), {
      authorId,
      body,
      createdAt: String(now),
    })
    await this.redis.zadd(kTimeline(authorId), now, id)
    return { id, authorId, body, createdAt: now }
  }

  async getPost(id: PostId): Promise<Post | null> {
    const key = tryNormalizeId(id)
    return key ? readPost(await this.redis.hgetall(kPost(key))) : null
  }

  async expirePost(id: PostId, ttlMs: number): Promise<boolean> {
    const key = tryNormalizeId(id)
    if (!key || ttlMs < 1) return false
    if (!(await this.getPost(key))) return false
    return this.redis.pexpire(kPost(key), ttlMs)
  }

  async postsByAuthor(authorId: UserId, page?: Page): Promise<Post[]> {
    const id = await this.requireUser(authorId)
    return this.newest([id], page)
  }

  async feed(userId: UserId, page?: Page): Promise<Post[]> {
    const id = await this.requireUser(userId)
    const followees = await this.redis.smembers(kFollowing(id))
    return this.newest(followees, page)
  }

  private async requireUser(id: UserId): Promise<UserId> {
    const key = tryNormalizeId(id)
    if (!key || !readUser(await this.redis.hgetall(kUser(key)))) {
      throw new StoreError('user_not_found')
    }
    return key
  }

  private async newest(authorIds: UserId[], page?: Page): Promise<Post[]> {
    const limit = pageLimit(page)
    const lists = await Promise.all(
      authorIds.map((id) => this.loadTimeline(id, limit, page?.before)),
    )
    return mergeNewest(lists, limit)
  }

  private async loadTimeline(
    authorId: UserId,
    limit: number,
    cursor?: FeedCursor,
  ): Promise<Post[]> {
    const max = cursor?.createdAt ?? Number.POSITIVE_INFINITY
    const raw = await this.redis.zrevrangebyscore(kTimeline(authorId), max, Number.NEGATIVE_INFINITY)
    const out: Post[] = []
    for (const { member } of raw) {
      const post = await this.hydrate(authorId, member)
      if (!post) continue
      if (!isBeforeCursor(post, cursor)) continue
      out.push(post)
      if (out.length >= limit) break
    }
    return out
  }

  private async hydrate(authorId: UserId, postId: PostId): Promise<Post | null> {
    const post = readPost(await this.redis.hgetall(kPost(postId)))
    if (post) return post
    await this.redis.zrem(kTimeline(authorId), postId)
    return null
  }
}

function readUser(f: Record<string, string>): User | null {
  const createdAt = Number(f.createdAt)
  if (!f.id || !f.handle || !Number.isFinite(createdAt)) return null
  return { id: f.id, handle: f.handle, createdAt }
}

function readPost(f: Record<string, string>): Post | null {
  const createdAt = Number(f.createdAt)
  if (!f.id || !f.authorId || !f.body || !Number.isFinite(createdAt)) return null
  return { id: f.id, authorId: f.authorId, body: f.body, createdAt }
}

function mergeNewest(lists: Post[][], limit: number): Post[] {
  const heads = lists.map(() => 0)
  const out: Post[] = []
  while (out.length < limit) {
    let bestI = -1
    let best: Post | undefined
    for (let i = 0; i < lists.length; i++) {
      const cand = lists[i]?.[heads[i] ?? 0]
      if (!cand) continue
      if (!best || comparePosts(cand, best) < 0) {
        best = cand
        bestI = i
      }
    }
    if (!best || bestI < 0) break
    out.push(best)
    heads[bestI] = (heads[bestI] ?? 0) + 1
  }
  return out
}
