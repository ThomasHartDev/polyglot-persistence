export { SCHEMA_STATEMENTS, SQL } from '../postgres/schema'

export const HASH_BUCKETS = 16

// Follows PK and posts_author_timeline stay ordered so a prefix scan hits one range.
export const CRDB_HASH_STATEMENTS = [
  `ALTER TABLE users ALTER PRIMARY KEY USING COLUMNS (id) USING HASH WITH (bucket_count = ${HASH_BUCKETS})`,
  `ALTER TABLE posts ALTER PRIMARY KEY USING COLUMNS (id) USING HASH WITH (bucket_count = ${HASH_BUCKETS})`,
  `CREATE INDEX IF NOT EXISTS posts_created_at_hash_idx ON posts (created_at DESC) USING HASH WITH (bucket_count = 8)`,
] as const
