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
} from './domain'
import type { ActivityStore, CreateUserInput, PublishInput } from './store'

export class MemoryStore implements ActivityStore {
  private readonly users = new Map<UserId, User>()
  private readonly handles = new Map<string, UserId>()
  private readonly followingOf = new Map<UserId, Set<UserId>>()
  private readonly followersOf = new Map<UserId, Set<UserId>>()
  private readonly posts = new Map<PostId, Post>()
  private readonly authorPosts = new Map<UserId, Post[]>()

  async createUser(input: CreateUserInput, now = Date.now()): Promise<User> {
    const id = normalizeId(input.id)
    const handle = normalizeHandle(input.handle)
    if (this.users.has(id)) throw new StoreError('user_exists')
    if (this.handles.has(handle)) throw new StoreError('handle_taken')
    const user: User = { id, handle, createdAt: now }
    this.users.set(id, user)
    this.handles.set(handle, id)
    this.followingOf.set(id, new Set())
    this.followersOf.set(id, new Set())
    this.authorPosts.set(id, [])
    return { ...user }
  }

  async getUser(id: UserId): Promise<User | null> {
    const key = tryNormalizeId(id)
    if (!key) return null
    const user = this.users.get(key)
    return user ? { ...user } : null
  }

  async getUserByHandle(handle: string): Promise<User | null> {
    const key = tryNormalizeHandle(handle)
    if (!key) return null
    const id = this.handles.get(key)
    return id === undefined ? null : this.getUser(id)
  }

  async follow(followerId: UserId, followeeId: UserId): Promise<void> {
    const from = this.requireUser(followerId)
    const to = this.requireUser(followeeId)
    if (from === to) throw new StoreError('self_follow')
    this.followingOf.get(from)?.add(to)
    this.followersOf.get(to)?.add(from)
  }

  async unfollow(followerId: UserId, followeeId: UserId): Promise<void> {
    const from = this.requireUser(followerId)
    const to = this.requireUser(followeeId)
    this.followingOf.get(from)?.delete(to)
    this.followersOf.get(to)?.delete(from)
  }

  async isFollowing(followerId: UserId, followeeId: UserId): Promise<boolean> {
    const from = this.requireUser(followerId)
    const to = this.requireUser(followeeId)
    return this.followingOf.get(from)?.has(to) ?? false
  }

  async following(userId: UserId): Promise<UserId[]> {
    const id = this.requireUser(userId)
    return [...(this.followingOf.get(id) ?? [])].sort()
  }

  async followers(userId: UserId): Promise<UserId[]> {
    const id = this.requireUser(userId)
    return [...(this.followersOf.get(id) ?? [])].sort()
  }

  async publish(input: PublishInput, now = Date.now()): Promise<Post> {
    const id = normalizeId(input.id)
    const authorId = this.requireUser(input.authorId)
    const body = normalizeBody(input.body)
    if (this.posts.has(id)) throw new StoreError('post_exists')
    const timeline = this.authorPosts.get(authorId)
    if (!timeline) throw new StoreError('user_not_found')
    const post: Post = { id, authorId, body, createdAt: now }
    this.posts.set(id, post)
    insertSorted(timeline, post)
    return { ...post }
  }

  async getPost(id: PostId): Promise<Post | null> {
    const key = tryNormalizeId(id)
    if (!key) return null
    const post = this.posts.get(key)
    return post ? { ...post } : null
  }

  async postsByAuthor(authorId: UserId, page?: Page): Promise<Post[]> {
    const id = this.requireUser(authorId)
    return mergeNewest([this.authorPosts.get(id) ?? []], pageLimit(page), page?.before)
  }

  async feed(userId: UserId, page?: Page): Promise<Post[]> {
    const id = this.requireUser(userId)
    const lists: Post[][] = []
    for (const followee of this.followingOf.get(id) ?? []) {
      const list = this.authorPosts.get(followee)
      if (list && list.length > 0) lists.push(list)
    }
    return mergeNewest(lists, pageLimit(page), page?.before)
  }

  private requireUser(id: UserId): UserId {
    const key = tryNormalizeId(id)
    if (!key || !this.users.has(key)) throw new StoreError('user_not_found')
    return key
  }
}

function insertSorted(list: Post[], post: Post): void {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const at = list[mid]
    if (at !== undefined && comparePosts(at, post) <= 0) lo = mid + 1
    else hi = mid
  }
  list.splice(lo, 0, post)
}

function mergeNewest(lists: Post[][], limit: number, cursor?: FeedCursor): Post[] {
  const heads = lists.map((list) => firstAtOrBefore(list, cursor))
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
    out.push({ ...best })
    heads[bestI] = (heads[bestI] ?? 0) + 1
  }
  return out
}

function firstAtOrBefore(list: Post[], cursor?: FeedCursor): number {
  const i = list.findIndex((post) => isBeforeCursor(post, cursor))
  return i === -1 ? list.length : i
}
