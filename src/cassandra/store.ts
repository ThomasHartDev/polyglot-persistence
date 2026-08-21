import {
  comparePosts,
  normalizeBody,
  normalizeHandle,
  normalizeId,
  pageLimit,
  StoreError,
  tryNormalizeHandle,
  tryNormalizeId,
  type Page,
  type Post,
  type PostId,
  type User,
  type UserId,
} from '../domain'
import type { ActivityStore, CreateUserInput, PublishInput } from '../store'
import { MemoryCassandra, TABLES, type Row } from './memory'

export { InvalidQueryError, MemoryCassandra, TABLES, TABLE_LIST, toCreateCql } from './memory'
export type { Cell, Row, SelectOpts, TableSchema } from './memory'

export class CassandraStore implements ActivityStore {
  private constructor(private readonly ks: MemoryCassandra) {}

  static attach(ks: MemoryCassandra): CassandraStore {
    return new CassandraStore(ks)
  }

  async createUser(input: CreateUserInput, now = Date.now()): Promise<User> {
    const id = normalizeId(input.id)
    const handle = normalizeHandle(input.handle)
    if (!this.ks.insert(TABLES.usersById.name, { user_id: id, handle, created_at: now }, { ifNotExists: true }).applied) {
      throw new StoreError('user_exists')
    }
    if (
      !this.ks.insert(TABLES.usersByHandle.name, { handle, user_id: id, created_at: now }, { ifNotExists: true }).applied
    ) {
      this.ks.delete(TABLES.usersById.name, { user_id: id })
      throw new StoreError('handle_taken')
    }
    return { id, handle, createdAt: now }
  }

  async getUser(id: UserId): Promise<User | null> {
    const key = tryNormalizeId(id)
    if (!key) return null
    const row = this.ks.select(TABLES.usersById.name, { eq: { user_id: key } })[0]
    return row ? toUser(row) : null
  }

  async getUserByHandle(handle: string): Promise<User | null> {
    const key = tryNormalizeHandle(handle)
    if (!key) return null
    const row = this.ks.select(TABLES.usersByHandle.name, { eq: { handle: key } })[0]
    return row ? this.getUser(String(row.user_id)) : null
  }

  async follow(followerId: UserId, followeeId: UserId): Promise<void> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    if (from === to) throw new StoreError('self_follow')
    this.ks.insert(TABLES.followingByUser.name, { follower_id: from, followee_id: to })
    this.ks.insert(TABLES.followersByUser.name, { followee_id: to, follower_id: from })
  }

  async unfollow(followerId: UserId, followeeId: UserId): Promise<void> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    this.ks.delete(TABLES.followingByUser.name, { follower_id: from, followee_id: to })
    this.ks.delete(TABLES.followersByUser.name, { followee_id: to, follower_id: from })
  }

  async isFollowing(followerId: UserId, followeeId: UserId): Promise<boolean> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    return this.ks.select(TABLES.followingByUser.name, {
      eq: { follower_id: from, followee_id: to },
      limit: 1,
    }).length > 0
  }

  async following(userId: UserId): Promise<UserId[]> {
    const id = await this.requireUser(userId)
    return this.ks.select(TABLES.followingByUser.name, { eq: { follower_id: id } }).map((row) => String(row.followee_id))
  }

  async followers(userId: UserId): Promise<UserId[]> {
    const id = await this.requireUser(userId)
    return this.ks.select(TABLES.followersByUser.name, { eq: { followee_id: id } }).map((row) => String(row.follower_id))
  }

  async publish(input: PublishInput, now = Date.now()): Promise<Post> {
    const id = normalizeId(input.id)
    const authorId = await this.requireUser(input.authorId)
    const body = normalizeBody(input.body)
    const row = { post_id: id, author_id: authorId, body, created_at: now }
    if (!this.ks.insert(TABLES.postsById.name, row, { ifNotExists: true }).applied) {
      throw new StoreError('post_exists')
    }
    this.ks.insert(TABLES.postsByAuthor.name, row)
    return { id, authorId, body, createdAt: now }
  }

  async getPost(id: PostId): Promise<Post | null> {
    const key = tryNormalizeId(id)
    if (!key) return null
    const row = this.ks.select(TABLES.postsById.name, { eq: { post_id: key } })[0]
    return row ? toPost(row) : null
  }

  async postsByAuthor(authorId: UserId, page?: Page): Promise<Post[]> {
    return this.timeline(await this.requireUser(authorId), page)
  }

  async feed(userId: UserId, page?: Page): Promise<Post[]> {
    const id = await this.requireUser(userId)
    const followees = this.ks.select(TABLES.followingByUser.name, { eq: { follower_id: id } })
    return mergeNewest(
      followees.map((row) => this.timeline(String(row.followee_id), page)),
      pageLimit(page),
    )
  }

  private timeline(authorId: UserId, page?: Page): Post[] {
    const before = page?.before
    return this.ks
      .select(TABLES.postsByAuthor.name, {
        eq: { author_id: authorId },
        clusteringLt: before ? { created_at: before.createdAt, post_id: before.id } : undefined,
        limit: pageLimit(page),
      })
      .map(toPost)
  }

  private async requireUser(id: UserId): Promise<UserId> {
    const key = tryNormalizeId(id)
    if (!key) throw new StoreError('user_not_found')
    if (!this.ks.select(TABLES.usersById.name, { eq: { user_id: key } })[0]) {
      throw new StoreError('user_not_found')
    }
    return key
  }
}

function toUser(row: Row): User {
  return { id: String(row.user_id), handle: String(row.handle), createdAt: Number(row.created_at) }
}

function toPost(row: Row): Post {
  return {
    id: String(row.post_id),
    authorId: String(row.author_id),
    body: String(row.body),
    createdAt: Number(row.created_at),
  }
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
