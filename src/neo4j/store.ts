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
  type Page,
  type Post,
  type PostId,
  type User,
  type UserId,
} from '../domain'
import type { ActivityStore, CreateUserInput, PublishInput } from '../store'
import { CONSTRAINTS } from './cypher'
import { MemoryGraph, type Props } from './memory'

export { CONSTRAINTS, CYPHER } from './cypher'
export { ConstraintError, MemoryGraph } from './memory'

export class Neo4jStore implements ActivityStore {
  private constructor(private readonly g: MemoryGraph) {}

  static create(g: MemoryGraph): Neo4jStore {
    for (const cypher of CONSTRAINTS) g.constrain(cypher)
    return new Neo4jStore(g)
  }

  async createUser(input: CreateUserInput, now = Date.now()): Promise<User> {
    const id = normalizeId(input.id)
    const handle = normalizeHandle(input.handle)
    try {
      this.g.createNode(['User'], { id, handle, createdAt: now })
    } catch (err) {
      throwMapped(err)
    }
    return { id, handle, createdAt: now }
  }

  async getUser(id: UserId): Promise<User | null> {
    const key = tryNormalizeId(id)
    if (!key) return null
    return toUser(this.g.props(this.g.find('User', 'id', key)))
  }

  async getUserByHandle(handle: string): Promise<User | null> {
    const key = tryNormalizeHandle(handle)
    if (!key) return null
    return toUser(this.g.props(this.g.find('User', 'handle', key)))
  }

  async follow(followerId: UserId, followeeId: UserId): Promise<void> {
    const from = this.requireUser(followerId)
    const to = this.requireUser(followeeId)
    if (from === to) throw new StoreError('self_follow')
    this.g.mergeRel(from, 'FOLLOWS', to)
  }

  async unfollow(followerId: UserId, followeeId: UserId): Promise<void> {
    this.g.deleteRel(this.requireUser(followerId), 'FOLLOWS', this.requireUser(followeeId))
  }

  async isFollowing(followerId: UserId, followeeId: UserId): Promise<boolean> {
    return this.g
      .neighbors(this.requireUser(followerId), 'FOLLOWS')
      .includes(this.requireUser(followeeId))
  }

  async following(userId: UserId): Promise<UserId[]> {
    return ids(this.g, this.g.neighbors(this.requireUser(userId), 'FOLLOWS'))
  }

  async followers(userId: UserId): Promise<UserId[]> {
    return ids(this.g, this.g.inbound(this.requireUser(userId), 'FOLLOWS'))
  }

  async publish(input: PublishInput, now = Date.now()): Promise<Post> {
    const id = normalizeId(input.id)
    const author = this.requireUser(input.authorId)
    const body = normalizeBody(input.body)
    let post: string
    try {
      post = this.g.createNode(['Post'], { id, body, createdAt: now })
    } catch (err) {
      throwMapped(err)
    }
    this.g.mergeRel(author, 'AUTHORED', post)
    return { id, authorId: String(this.g.props(author)?.id), body, createdAt: now }
  }

  async getPost(id: PostId): Promise<Post | null> {
    const key = tryNormalizeId(id)
    if (!key) return null
    const post = this.g.find('Post', 'id', key)
    const author = post ? this.g.inbound(post, 'AUTHORED')[0] : undefined
    return toPost(this.g.props(author), this.g.props(post))
  }

  async postsByAuthor(authorId: UserId, page?: Page): Promise<Post[]> {
    return pagePosts(authored(this.g, this.requireUser(authorId)), page)
  }

  async feed(userId: UserId, page?: Page): Promise<Post[]> {
    const posts: Post[] = []
    for (const followee of this.g.neighbors(this.requireUser(userId), 'FOLLOWS')) {
      posts.push(...authored(this.g, followee))
    }
    return pagePosts(posts, page)
  }

  async shortestFollowPath(fromId: UserId, toId: UserId): Promise<UserId[] | null> {
    // WHY: unbounded * is a full-graph BFS; 16 hops is the lab cap.
    return this.g.bfs(this.requireUser(fromId), this.requireUser(toId), 'FOLLOWS', 16)
  }

  async recommendFollows(userId: UserId, limit = 10): Promise<{ id: UserId; score: number }[]> {
    const from = this.requireUser(userId)
    const direct = new Set(this.g.neighbors(from, 'FOLLOWS'))
    const scores = new Map<string, number>()
    for (const hop of direct) {
      for (const rec of this.g.neighbors(hop, 'FOLLOWS')) {
        if (rec === from || direct.has(rec)) continue
        scores.set(rec, (scores.get(rec) ?? 0) + 1)
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id: String(this.g.props(id)?.id), score }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, pageLimit({ limit }))
  }

  async isMutual(aId: UserId, bId: UserId): Promise<boolean> {
    const a = this.requireUser(aId)
    const b = this.requireUser(bId)
    return this.g.neighbors(a, 'FOLLOWS').includes(b) && this.g.neighbors(b, 'FOLLOWS').includes(a)
  }

  async commonFollowees(aId: UserId, bId: UserId): Promise<UserId[]> {
    const other = new Set(this.g.neighbors(this.requireUser(bId), 'FOLLOWS'))
    return ids(this.g, this.g.neighbors(this.requireUser(aId), 'FOLLOWS').filter((id) => other.has(id)))
  }

  private requireUser(id: UserId): string {
    const key = tryNormalizeId(id)
    const node = key ? this.g.find('User', 'id', key) : undefined
    if (!node) throw new StoreError('user_not_found')
    return node
  }
}

function ids(g: MemoryGraph, nodes: string[]): UserId[] {
  return nodes.map((id) => String(g.props(id)?.id)).sort()
}

function authored(g: MemoryGraph, author: string): Post[] {
  const a = g.props(author)
  if (!a) return []
  const out: Post[] = []
  for (const post of g.neighbors(author, 'AUTHORED')) {
    const row = toPost(a, g.props(post))
    if (row) out.push(row)
  }
  return out
}

function pagePosts(posts: Post[], page?: Page): Post[] {
  return posts
    .filter((post) => isBeforeCursor(post, page?.before))
    .sort(comparePosts)
    .slice(0, pageLimit(page))
}

function toUser(props: Props | undefined): User | null {
  if (!props) return null
  return { id: String(props.id), handle: String(props.handle), createdAt: Number(props.createdAt) }
}

function toPost(author: Props | undefined, post: Props | undefined): Post | null {
  if (!author || !post) return null
  return {
    id: String(post.id),
    authorId: String(author.id),
    body: String(post.body),
    createdAt: Number(post.createdAt),
  }
}

function throwMapped(err: unknown): never {
  const rec =
    typeof err === 'object' && err !== null
      ? (err as { code?: unknown; constraint?: unknown; message?: unknown })
      : undefined
  if (rec?.code === 'Neo.ClientError.Schema.ConstraintValidationFailed') {
    if (rec.constraint === 'user_id') throw new StoreError('user_exists')
    if (rec.constraint === 'user_handle') throw new StoreError('handle_taken')
    if (rec.constraint === 'post_id') throw new StoreError('post_exists')
    const mapped = mapDriverMessage(typeof rec.message === 'string' ? rec.message : '')
    if (mapped) throw new StoreError(mapped)
  }
  throw err
}

function mapDriverMessage(message: string): 'user_exists' | 'handle_taken' | 'post_exists' | undefined {
  const m = /label `(\w+)` and property `(\w+)`/.exec(message)
  if (m?.[1] === 'User' && m[2] === 'handle') return 'handle_taken'
  if (m?.[1] === 'User' && m[2] === 'id') return 'user_exists'
  if (m?.[1] === 'Post' && m[2] === 'id') return 'post_exists'
  return undefined
}
