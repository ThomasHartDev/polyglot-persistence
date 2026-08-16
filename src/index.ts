export const VERSION = '0.2.0'
export { BODY_MAX, StoreError } from './domain'
export type {
  FeedCursor,
  Page,
  Post,
  PostId,
  StoreErrorCode,
  User,
  UserId,
} from './domain'
export type { ActivityStore, CreateUserInput, PublishInput } from './store'
export { MemoryStore } from './memory-store'
export { PostgresStore, SCHEMA_STATEMENTS, SQL } from './postgres/store'
export type { SqlQuery } from './postgres/store'
