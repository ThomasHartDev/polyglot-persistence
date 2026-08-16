import {
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
import { SCHEMA_STATEMENTS, SQL } from './schema'

export { SCHEMA_STATEMENTS, SQL } from './schema'

export interface SqlQuery {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>
}

interface UserRow {
  id: string
  handle: string
  created_at: string | number
}

interface PostRow {
  id: string
  author_id: string
  body: string
  created_at: string | number
}

interface FolloweeRow {
  followee_id: string
}

interface FollowerRow {
  follower_id: string
}

export class PostgresStore implements ActivityStore {
  private constructor(private readonly sql: SqlQuery) {}

  static async migrate(sql: SqlQuery): Promise<void> {
    for (const statement of SCHEMA_STATEMENTS) {
      await sql.query(statement)
    }
  }

  static attach(sql: SqlQuery): PostgresStore {
    return new PostgresStore(sql)
  }

  static async create(sql: SqlQuery): Promise<PostgresStore> {
    await PostgresStore.migrate(sql)
    return PostgresStore.attach(sql)
  }

  async createUser(input: CreateUserInput, now = Date.now()): Promise<User> {
    const id = normalizeId(input.id)
    const handle = normalizeHandle(input.handle)
    try {
      const { rows } = await this.sql.query<UserRow>(SQL.insertUser, [id, handle, now])
      const row = rows[0]
      if (!row) throw new StoreError('user_exists')
      return toUser(row)
    } catch (err) {
      throwMapped(err)
    }
  }

  async getUser(id: UserId): Promise<User | null> {
    const key = tryNormalizeId(id)
    if (!key) return null
    const { rows } = await this.sql.query<UserRow>(SQL.selectUser, [key])
    const row = rows[0]
    return row ? toUser(row) : null
  }

  async getUserByHandle(handle: string): Promise<User | null> {
    const key = tryNormalizeHandle(handle)
    if (!key) return null
    const { rows } = await this.sql.query<UserRow>(SQL.selectUserByHandle, [key])
    const row = rows[0]
    return row ? toUser(row) : null
  }

  async follow(followerId: UserId, followeeId: UserId): Promise<void> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    if (from === to) throw new StoreError('self_follow')
    try {
      await this.sql.query(SQL.insertFollow, [from, to])
    } catch (err) {
      throwMapped(err)
    }
  }

  async unfollow(followerId: UserId, followeeId: UserId): Promise<void> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    await this.sql.query(SQL.deleteFollow, [from, to])
  }

  async isFollowing(followerId: UserId, followeeId: UserId): Promise<boolean> {
    const from = await this.requireUser(followerId)
    const to = await this.requireUser(followeeId)
    const { rows } = await this.sql.query(SQL.hasFollow, [from, to])
    return rows.length > 0
  }

  async following(userId: UserId): Promise<UserId[]> {
    const id = await this.requireUser(userId)
    const { rows } = await this.sql.query<FolloweeRow>(SQL.following, [id])
    return rows.map((row) => row.followee_id)
  }

  async followers(userId: UserId): Promise<UserId[]> {
    const id = await this.requireUser(userId)
    const { rows } = await this.sql.query<FollowerRow>(SQL.followers, [id])
    return rows.map((row) => row.follower_id)
  }

  async publish(input: PublishInput, now = Date.now()): Promise<Post> {
    const id = normalizeId(input.id)
    const authorId = await this.requireUser(input.authorId)
    const body = normalizeBody(input.body)
    try {
      const { rows } = await this.sql.query<PostRow>(SQL.insertPost, [
        id,
        authorId,
        body,
        now,
      ])
      const row = rows[0]
      if (!row) throw new StoreError('post_exists')
      return toPost(row)
    } catch (err) {
      throwMapped(err)
    }
  }

  async getPost(id: PostId): Promise<Post | null> {
    const key = tryNormalizeId(id)
    if (!key) return null
    const { rows } = await this.sql.query<PostRow>(SQL.selectPost, [key])
    const row = rows[0]
    return row ? toPost(row) : null
  }

  async postsByAuthor(authorId: UserId, page?: Page): Promise<Post[]> {
    const id = await this.requireUser(authorId)
    const limit = pageLimit(page)
    const before = page?.before
    const { rows } = before
      ? await this.sql.query<PostRow>(SQL.authorTimelineBefore, [
          id,
          before.createdAt,
          before.id,
          limit,
        ])
      : await this.sql.query<PostRow>(SQL.authorTimeline, [id, limit])
    return rows.map(toPost)
  }

  async feed(userId: UserId, page?: Page): Promise<Post[]> {
    const id = await this.requireUser(userId)
    const limit = pageLimit(page)
    const before = page?.before
    const { rows } = before
      ? await this.sql.query<PostRow>(SQL.feedBefore, [
          id,
          before.createdAt,
          before.id,
          limit,
        ])
      : await this.sql.query<PostRow>(SQL.feed, [id, limit])
    return rows.map(toPost)
  }

  private async requireUser(id: UserId): Promise<UserId> {
    const key = tryNormalizeId(id)
    if (!key) throw new StoreError('user_not_found')
    const { rows } = await this.sql.query<UserRow>(SQL.selectUser, [key])
    if (!rows[0]) throw new StoreError('user_not_found')
    return key
  }
}

function epoch(value: string | number): number {
  return typeof value === 'number' ? value : Number(value)
}

function toUser(row: UserRow): User {
  return { id: row.id, handle: row.handle, createdAt: epoch(row.created_at) }
}

function toPost(row: PostRow): Post {
  return {
    id: row.id,
    authorId: row.author_id,
    body: row.body,
    createdAt: epoch(row.created_at),
  }
}

function pgField(err: unknown, key: 'code' | 'constraint'): string | undefined {
  if (typeof err !== 'object' || err === null || !(key in err)) return undefined
  const value = (err as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

function throwMapped(err: unknown): never {
  const code = pgField(err, 'code')
  const constraint = pgField(err, 'constraint')
  if (code === '23505') {
    if (constraint === 'users_pkey') throw new StoreError('user_exists')
    if (constraint === 'users_handle_uidx') throw new StoreError('handle_taken')
    if (constraint === 'posts_pkey') throw new StoreError('post_exists')
  }
  if (code === '23514' && constraint === 'follows_no_self') {
    throw new StoreError('self_follow')
  }
  if (code === '23503') throw new StoreError('user_not_found')
  throw err
}
