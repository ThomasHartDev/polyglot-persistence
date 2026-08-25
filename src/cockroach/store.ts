import type { Page, Post, PostId, User, UserId } from '../domain'
import { PostgresStore, type SqlQuery } from '../postgres/store'
import type { ActivityStore, CreateUserInput, PublishInput } from '../store'
import { CRDB_HASH_STATEMENTS } from './schema'
import { DEFAULT_RETRY, withSerializableRetry, type RetryPolicy } from './retry'

export { CRDB_HASH_STATEMENTS, HASH_BUCKETS } from './schema'
export {
  DEFAULT_RETRY,
  SERIALIZATION_FAILURE,
  retryableSqlError,
  withSerializableRetry,
} from './retry'
export type { RetryPolicy } from './retry'
export {
  FEED_LAYOUT,
  Keyspace,
  fnv1a,
  hashBucket,
  hashShardedIndexKey,
  hashShardedKey,
  layoutHash,
  orderedIndexKey,
  serialKey,
  shouldHashShard,
  uuidKey,
} from './hotspot'
export type { AccessShape, FeedIndex } from './hotspot'

export class CockroachStore implements ActivityStore {
  private constructor(
    private readonly inner: PostgresStore,
    private readonly policy: RetryPolicy,
  ) {}

  static attach(sql: SqlQuery, policy: RetryPolicy = DEFAULT_RETRY): CockroachStore {
    return new CockroachStore(PostgresStore.attach(sql), policy)
  }

  static async migrate(sql: SqlQuery, applyHashLayout = false): Promise<void> {
    await PostgresStore.migrate(sql)
    if (!applyHashLayout) return
    for (const statement of CRDB_HASH_STATEMENTS) {
      await sql.query(statement)
    }
  }

  static async create(
    sql: SqlQuery,
    policy: RetryPolicy = DEFAULT_RETRY,
  ): Promise<CockroachStore> {
    await CockroachStore.migrate(sql)
    return CockroachStore.attach(sql, policy)
  }

  createUser(input: CreateUserInput, now = Date.now()): Promise<User> {
    return this.retry(() => this.inner.createUser(input, now))
  }

  getUser(id: UserId): Promise<User | null> {
    return this.retry(() => this.inner.getUser(id))
  }

  getUserByHandle(handle: string): Promise<User | null> {
    return this.retry(() => this.inner.getUserByHandle(handle))
  }

  follow(followerId: UserId, followeeId: UserId): Promise<void> {
    return this.retry(() => this.inner.follow(followerId, followeeId))
  }

  unfollow(followerId: UserId, followeeId: UserId): Promise<void> {
    return this.retry(() => this.inner.unfollow(followerId, followeeId))
  }

  isFollowing(followerId: UserId, followeeId: UserId): Promise<boolean> {
    return this.retry(() => this.inner.isFollowing(followerId, followeeId))
  }

  following(userId: UserId): Promise<UserId[]> {
    return this.retry(() => this.inner.following(userId))
  }

  followers(userId: UserId): Promise<UserId[]> {
    return this.retry(() => this.inner.followers(userId))
  }

  publish(input: PublishInput, now = Date.now()): Promise<Post> {
    return this.retry(() => this.inner.publish(input, now))
  }

  getPost(id: PostId): Promise<Post | null> {
    return this.retry(() => this.inner.getPost(id))
  }

  postsByAuthor(authorId: UserId, page?: Page): Promise<Post[]> {
    return this.retry(() => this.inner.postsByAuthor(authorId, page))
  }

  feed(userId: UserId, page?: Page): Promise<Post[]> {
    return this.retry(() => this.inner.feed(userId, page))
  }

  private retry<T>(op: () => Promise<T>): Promise<T> {
    return withSerializableRetry(op, this.policy)
  }
}
