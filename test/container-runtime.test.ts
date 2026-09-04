import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresStore } from '../src/postgres/store'
import {
  CONTAINER_BACKENDS,
  POSTGRES_IMAGE,
  startPostgres,
  type StartedPostgres,
} from './container-runtime'

describe('container backend registry', () => {
  it('pins every container-backed engine to a versioned image', () => {
    expect(CONTAINER_BACKENDS.postgres).toBe(POSTGRES_IMAGE)
    for (const image of Object.values(CONTAINER_BACKENDS)) {
      expect(image).toMatch(/:\d+/)
      expect(image.endsWith(':latest')).toBe(false)
    }
  })
})

describe('postgres testcontainer', () => {
  let left!: StartedPostgres
  let right!: StartedPostgres

  beforeAll(async () => {
    ;[left, right] = await Promise.all([startPostgres(), startPostgres()])
    await Promise.all([PostgresStore.migrate(left.sql), PostgresStore.migrate(right.sql)])
  }, 120_000)

  afterAll(async () => {
    await Promise.all([left?.stop(), right?.stop()])
  })

  it('answers SELECT 1 only after the health and port wait unblocks', async () => {
    const { rows } = await left.sql.query<{ n: number }>('SELECT 1::int AS n')
    expect(rows[0]?.n).toBe(1)
  })

  it('exposes a mapped-port URI a second client process can use', async () => {
    const url = new URL(left.uri)
    expect(url.protocol).toMatch(/^postgres/)
    expect(url.username).toBe('feed')
    expect(url.pathname).toBe('/feed')
    expect(Number(url.port)).toBeGreaterThan(0)

    const outsider = new Pool({
      connectionString: left.uri,
      max: 1,
      connectionTimeoutMillis: 2_000,
    })
    try {
      const { rows } = await outsider.query('SELECT current_database() AS db')
      expect(rows[0]?.db).toBe('feed')
    } finally {
      await outsider.end()
    }
  })

  it('gives each engine its own catalog and host port', async () => {
    expect(left.uri).not.toBe(right.uri)
    expect(new URL(left.uri).port).not.toBe(new URL(right.uri).port)

    await left.sql.query(
      `INSERT INTO users (id, handle, created_at) VALUES ('ada', 'ada', 1)`,
    )
    const { rows: leftRows } = await left.sql.query<{ id: string }>(
      'SELECT id FROM users ORDER BY id',
    )
    const { rows: rightRows } = await right.sql.query<{ id: string }>(
      'SELECT id FROM users ORDER BY id',
    )
    expect(leftRows.map((row) => row.id)).toEqual(['ada'])
    expect(rightRows).toEqual([])
  })

  it('reset truncates rows and keeps the schema', async () => {
    await left.reset()
    const { rows } = await left.sql.query('SELECT id FROM users')
    expect(rows).toEqual([])

    const { rows: indexes } = await left.sql.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'posts_author_timeline_idx'`,
    )
    expect(indexes.map((row) => row.indexname)).toEqual(['posts_author_timeline_idx'])
  })

  it('stop is idempotent and later queries fail while a sibling stays up', async () => {
    await right.stop()
    await right.stop()
    await expect(right.sql.query('SELECT 1')).rejects.toThrow()

    const { rows } = await left.sql.query<{ n: number }>('SELECT 1::int AS n')
    expect(rows[0]?.n).toBe(1)
  })
})
