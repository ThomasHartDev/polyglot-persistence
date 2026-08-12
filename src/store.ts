import type { Page, Post, PostId, User, UserId } from './domain'

export interface CreateUserInput {
  id: UserId
  handle: string
}

export interface PublishInput {
  id: PostId
  authorId: UserId
  body: string
}

export interface ActivityStore {
  createUser(input: CreateUserInput, now?: number): Promise<User>
  getUser(id: UserId): Promise<User | null>
  getUserByHandle(handle: string): Promise<User | null>

  follow(followerId: UserId, followeeId: UserId): Promise<void>
  unfollow(followerId: UserId, followeeId: UserId): Promise<void>
  isFollowing(followerId: UserId, followeeId: UserId): Promise<boolean>
  following(userId: UserId): Promise<UserId[]>
  followers(userId: UserId): Promise<UserId[]>

  publish(input: PublishInput, now?: number): Promise<Post>
  getPost(id: PostId): Promise<Post | null>
  postsByAuthor(authorId: UserId, page?: Page): Promise<Post[]>

  feed(userId: UserId, page?: Page): Promise<Post[]>
}
