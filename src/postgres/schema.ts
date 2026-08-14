export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    created_at BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_handle_uidx ON users (handle)`,
  `CREATE TABLE IF NOT EXISTS follows (
    follower_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    followee_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (follower_id, followee_id),
    CONSTRAINT follows_no_self CHECK (follower_id <> followee_id)
  )`,
  `CREATE INDEX IF NOT EXISTS follows_inbound_idx ON follows (followee_id)`,
  `CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    author_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    CONSTRAINT posts_body_len CHECK (char_length(body) BETWEEN 1 AND 280)
  )`,
  `CREATE INDEX IF NOT EXISTS posts_author_timeline_idx
    ON posts (author_id, created_at DESC, id DESC)`,
] as const

export const SQL = {
  insertUser: `INSERT INTO users (id, handle, created_at)
    VALUES ($1, $2, $3)
    RETURNING id, handle, created_at`,
  selectUser: `SELECT id, handle, created_at FROM users WHERE id = $1`,
  selectUserByHandle: `SELECT id, handle, created_at FROM users WHERE handle = $1`,
  insertFollow: `INSERT INTO follows (follower_id, followee_id)
    VALUES ($1, $2)
    ON CONFLICT (follower_id, followee_id) DO NOTHING`,
  deleteFollow: `DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`,
  hasFollow: `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2`,
  following: `SELECT followee_id FROM follows WHERE follower_id = $1 ORDER BY followee_id`,
  followers: `SELECT follower_id FROM follows WHERE followee_id = $1 ORDER BY follower_id`,
  insertPost: `INSERT INTO posts (id, author_id, body, created_at)
    VALUES ($1, $2, $3, $4)
    RETURNING id, author_id, body, created_at`,
  selectPost: `SELECT id, author_id, body, created_at FROM posts WHERE id = $1`,
  authorTimeline: `SELECT id, author_id, body, created_at
    FROM posts
    WHERE author_id = $1
      AND ($2::bigint IS NULL OR (created_at, id) < ($2::bigint, $3::text))
    ORDER BY created_at DESC, id DESC
    LIMIT $4`,
  feed: `SELECT p.id, p.author_id, p.body, p.created_at
    FROM posts p
    INNER JOIN follows f ON f.followee_id = p.author_id
    WHERE f.follower_id = $1
      AND ($2::bigint IS NULL OR (p.created_at, p.id) < ($2::bigint, $3::text))
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT $4`,
} as const
