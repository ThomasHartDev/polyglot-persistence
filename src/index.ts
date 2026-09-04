export const VERSION = '0.3.0'

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

export type {
  ActivityStore,
  CreateUserInput,
  PublishInput,
} from './store'

export { MemoryStore } from './memory-store'

export { PostgresStore, SCHEMA_STATEMENTS, SQL } from './postgres/store'

export type {
  SqlQuery,
} from './postgres/store'

export { MemoryRedis, RedisStore } from './redis/store'

export type {
  RedisCommands,
} from './redis/store'

export { MemoryMongo, MongoStore, INDEXES, keysetFilter } from './mongo/store'

export type {
  FollowDoc,
  MongoDb,
  PostDoc,
  UserDoc,
} from './mongo/store'

export {
  CassandraStore,
  InvalidQueryError,
  MemoryCassandra,
  TABLES,
  toCreateCql,
} from './cassandra/store'

export type {
  Cell,
  Row,
  SelectOpts,
  TableSchema,
} from './cassandra/store'
