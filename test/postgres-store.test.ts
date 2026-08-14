import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresStore, SQL } from '../src/postgres/store'
import { defineStoreContract } from './contract'

const db = new PGlite()

beforeAll(async () => {
  await db.waitReady
  await PostgresStore.migrate(db)
}, 30_000)

afterAll(async () => {
  await db.close()
})

defineStoreContract('postgres', async () => {
  await db.query('TRUNCATE TABLE users CASCADE')
  return PostgresStore.attach(db)
})

describe('postgres schema and planner', () => {
  it('creates the unique handle index and the author timeline index', async () => {
    const { rows } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('users_handle_uidx', 'posts_author_timeline_idx', 'follows_inbound_idx')
       ORDER BY indexname`,
    )
    expect(rows.map((row) => row.indexname)).toEqual([
      'follows_inbound_idx',
      'posts_author_timeline_idx',
      'users_handle_uidx',
    ])
  })

  it('rejects a self-follow at the table even when the store is skipped', async () => {
    await db.query('TRUNCATE TABLE users CASCADE')
    await db.query(`INSERT INTO users (id, handle, created_at) VALUES ('ada', 'ada', 1)`)
    await expect(
      db.query(`INSERT INTO follows (follower_id, followee_id) VALUES ('ada', 'ada')`),
    ).rejects.toMatchObject({ code: '23514', constraint: 'follows_no_self' })
  })

  it('enforces handle uniqueness at the table', async () => {
    await db.query('TRUNCATE TABLE users CASCADE')
    await db.query(`INSERT INTO users (id, handle, created_at) VALUES ('u1', 'ada', 1)`)
    await expect(
      db.query(`INSERT INTO users (id, handle, created_at) VALUES ('u2', 'ada', 2)`),
    ).rejects.toMatchObject({ code: '23505', constraint: 'users_handle_uidx' })
  })

  it('pages equal timestamps with a row-comparison keyset', async () => {
    await db.query('TRUNCATE TABLE users CASCADE')
    await db.query(
      `INSERT INTO users (id, handle, created_at) VALUES ('ada', 'ada', 1), ('bob', 'bob', 1)`,
    )
    await db.query(`INSERT INTO follows (follower_id, followee_id) VALUES ('ada', 'bob')`)
    await db.query(
      `INSERT INTO posts (id, author_id, body, created_at) VALUES
        ('p1', 'bob', 'older-id', 10),
        ('p2', 'bob', 'newer-id', 10),
        ('p3', 'bob', 'earlier', 4)`,
    )
    const first = await db.query<{ id: string }>(SQL.feed, ['ada', 1])
    expect(first.rows.map((row) => row.id)).toEqual(['p2'])
    const second = await db.query<{ id: string }>(SQL.feedBefore, ['ada', 10, 'p2', 2])
    expect(second.rows.map((row) => row.id)).toEqual(['p1', 'p3'])
  })

  it('walks posts_author_timeline_idx as an index-ordered scan after ANALYZE', async () => {
    await db.query('TRUNCATE TABLE users CASCADE')
    await db.query(
      `INSERT INTO users (id, handle, created_at) VALUES ('ada', 'ada', 1), ('bob', 'bob', 1)`,
    )
    await db.query(`INSERT INTO follows (follower_id, followee_id) VALUES ('ada', 'bob')`)
    await db.query(
      `INSERT INTO posts (id, author_id, body, created_at)
       SELECT 'p' || g, 'bob', 'body', g FROM generate_series(1, 500) AS g`,
    )
    await db.query('ANALYZE')

    const timeline = await explain(SQL.authorTimeline, ['bob', 20])
    expect(timeline).toContain('Index Scan using posts_author_timeline_idx')
    expect(timeline).not.toContain('Bitmap Index Scan')
    expect(timeline).not.toMatch(/\bSort\b/)

    const keyed = await explain(SQL.authorTimelineBefore, ['bob', 250, 'p250', 20])
    expect(keyed).toContain('Index Scan using posts_author_timeline_idx')
    expect(keyed).toContain('Index Cond:')
    expect(keyed).not.toContain('Bitmap Index Scan')
    expect(keyed).not.toMatch(/\bSort\b/)

    const feed = await explain(SQL.feed, ['ada', 20])
    expect(feed).toContain('Index Scan using posts_author_timeline_idx')
    expect(feed).not.toContain('Bitmap Index Scan')
  })
})

async function explain(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)
  return rows.map((row) => row['QUERY PLAN']).join('\n')
}
