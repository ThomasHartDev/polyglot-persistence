export type UserId = string
export type PostId = string

export interface User {
  id: UserId
  handle: string
  createdAt: number
}

export interface Post {
  id: PostId
  authorId: UserId
  body: string
  createdAt: number
}

export interface FeedCursor {
  createdAt: number
  id: PostId
}

export interface Page {
  limit?: number
  before?: FeedCursor
}

export const BODY_MAX = 280
export const ID_MAX = 64
export const DEFAULT_PAGE = 20
export const MAX_PAGE = 100

export type StoreErrorCode =
  | 'invalid_id'
  | 'invalid_handle'
  | 'invalid_body'
  | 'user_not_found'
  | 'user_exists'
  | 'handle_taken'
  | 'post_exists'
  | 'self_follow'

export class StoreError extends Error {
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message = code) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

const HANDLE_RE = /^[a-z][a-z0-9_]{0,19}$/
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/

export function normalizeHandle(raw: string): string {
  const handle = raw.trim().toLowerCase()
  if (!HANDLE_RE.test(handle)) {
    throw new StoreError('invalid_handle')
  }
  return handle
}

export function normalizeId(raw: string): string {
  const id = raw.trim()
  if (!ID_RE.test(id) || id.length > ID_MAX) {
    throw new StoreError('invalid_id')
  }
  return id
}

function tryCall<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch (err) {
    if (err instanceof StoreError) return null
    throw err
  }
}

export const tryNormalizeId = (raw: string) => tryCall(() => normalizeId(raw))
export const tryNormalizeHandle = (raw: string) => tryCall(() => normalizeHandle(raw))

export function normalizeBody(raw: string): string {
  const body = raw.trim()
  if (body.length === 0 || body.length > BODY_MAX) {
    throw new StoreError('invalid_body')
  }
  return body
}

export function pageLimit(page?: Page): number {
  const n = page?.limit
  if (n === undefined || !Number.isFinite(n) || n < 1) return DEFAULT_PAGE
  return Math.min(Math.floor(n), MAX_PAGE)
}

// createdAt DESC, id DESC so a (createdAt, id) cursor is a total order.
export function comparePosts(a: Post, b: Post): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt
  if (a.id === b.id) return 0
  return a.id < b.id ? 1 : -1
}

export function isBeforeCursor(post: Post, cursor?: FeedCursor): boolean {
  if (!cursor) return true
  if (post.createdAt !== cursor.createdAt) return post.createdAt < cursor.createdAt
  return post.id < cursor.id
}
