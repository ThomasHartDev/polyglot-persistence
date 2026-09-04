import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresStore, SQL } from '../src/postgres/store'
import { startPostgres, type StartedPostgres } from './container-runtime'
import { defineStoreContract } from './contract'

let engine!: StartedPostgres

beforeAll(async () => {
  engine = await startPostgres()
  await PostgresStore.migrate(engine.sql)
}, 120_000)

afterAll(async () => {
  await engine?.stop()
})

defineStoreContract('postgres', async () => {
  await engine.reset()
  return PostgresStore.attach(engine.sql)
})

describe('postgres schema and planner', () => {
  it('creates the unique handle index and the author timeline index', async () => {
    const { rows } = await engine.sql.query<{ indexname: string }>(
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
    await engine.reset()
    await engine.sql.query(`INSERT INTO users (id, handle, created_at) VALUES ('ada', 'ada', 1)`)
    await expect(
      engine.sql.query(`INSERT INTO follows (follower_id, followee_id) VALUES ('ada', 'ada')`),
    ).rejects.toMatchObject({ code: '23514', constraint: 'follows_no_self' })
  })

  it('enforces handle uniqueness at the table', async () => {
    await engine.reset()
    await engine.sql.query(`INSERT INTO users (id, handle, created_at) VALUES ('u1', 'ada', 1)`)
    await expect(
      engine.sql.query(`INSERT INTO users (id, handle, created_at) VALUES ('u2', 'ada', 2)`),
    ).rejects.toMatchObject({ code: '23505', constraint: 'users_handle_uidx' })
  })

  it('pages equal timestamps with a row-comparison keyset', async () => {
    await engine.reset()
    await engine.sql.query(
      `INSERT INTO users (id, handle, created_at) VALUES ('ada', 'ada', 1), ('bob', 'bob', 1)`,
    )
    await engine.sql.query(`INSERT INTO follows (follower_id, followee_id) VALUES ('ada', 'bob')`)
    await engine.sql.query(
      `INSERT INTO posts (id, author_id, body, created_at) VALUES
        ('p1', 'bob', 'older-id', 10),
        ('p2', 'bob', 'newer-id', 10),
        ('p3', 'bob', 'earlier', 4)`,
    )
    const first = await engine.sql.query<{ id: string }>(SQL.feed, ['ada', 1])
    expect(first.rows.map((row) => row.id)).toEqual(['p2'])
    const second = await engine.sql.query<{ id: string }>(SQL.feedBefore, ['ada', 10, 'p2', 2])
    expect(second.rows.map((row) => row.id)).toEqual(['p1', 'p3'])
  })

  it('walks posts_author_timeline_idx as an index-ordered scan after ANALYZE', async () => {
    await engine.reset()
    await engine.sql.query(
      `INSERT INTO users (id, handle, created_at) VALUES ('ada', 'ada', 1), ('bob', 'bob', 1)`,
    )
    await engine.sql.query(`INSERT INTO follows (follower_id, followee_id) VALUES ('ada', 'bob')`)
    await engine.sql.query(
      `INSERT INTO posts (id, author_id, body, created_at)
       SELECT 'p' || g, 'bob', 'body', g FROM generate_series(1, 500) AS g`,
    )
    await engine.sql.query('ANALYZE')

    const timeline = await explain(SQL.authorTimeline, ['bob', 20])
    expect(scansTimelineIndex(timeline)).toBe(true)
    expect(timeline).not.toContain('Bitmap Index Scan')
    expect(timeline).not.toMatch(/\bSort\b/)

    const keyed = await explain(SQL.authorTimelineBefore, ['bob', 250, 'p250', 20])
    expect(scansTimelineIndex(keyed)).toBe(true)
    expect(keyed).toContain('Index Cond:')
    expect(keyed).not.toContain('Bitmap Index Scan')
    expect(keyed).not.toMatch(/\bSort\b/)

    const feed = await explain(SQL.feed, ['ada', 20])
    expect(scansTimelineIndex(feed)).toBe(true)
    expect(feed).not.toContain('Bitmap Index Scan')
  })

  it('blocks a concurrent unique-handle insert until the first session commits', async () => {
    await engine.reset()
    const first = await engine.pool.connect()
    const second = await engine.pool.connect()
    try {
      const pidRow = await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      const pid = pidRow.rows[0]?.pid
      expect(pid).toEqual(expect.any(Number))

      await first.query('BEGIN')
      await first.query(
        `INSERT INTO users (id, handle, created_at) VALUES ('u1', 'ada', 1)`,
      )

      const blocked = second.query(
        `INSERT INTO users (id, handle, created_at) VALUES ('u2', 'ada', 2)`,
      )
      expect(await lockWaitEvent(pid!)).toBe('Lock')

      await first.query('COMMIT')
      await expect(blocked).rejects.toMatchObject({
        code: '23505',
        constraint: 'users_handle_uidx',
      })
    } finally {
      first.release()
      second.release()
    }
  })
})

async function explain(sql: string, params: unknown[]): Promise<string> {
  const { rows } = await engine.sql.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params)
  return rows.map((row) => row['QUERY PLAN']).join('\n')
}

function scansTimelineIndex(plan: string): boolean {
  return /Index(?: Only)? Scan using posts_author_timeline_idx/.test(plan)
}

async function lockWaitEvent(pid: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const { rows } = await engine.sql.query<{ wait_event_type: string | null }>(
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    )
    const type = rows[0]?.wait_event_type
    if (type === 'Lock') return type
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`backend ${pid} never waited on a unique-index lock`)
}
