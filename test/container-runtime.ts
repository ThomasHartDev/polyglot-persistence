import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { Pool, type QueryResultRow } from 'pg'
import type { SqlQuery } from '../src/postgres/store'

export const POSTGRES_IMAGE = 'postgres:16-alpine' as const

export const CONTAINER_BACKENDS = {
  postgres: POSTGRES_IMAGE,
} as const

export type ContainerBackend = keyof typeof CONTAINER_BACKENDS

const POOL_MAX = 8

export interface StartedPostgres {
  readonly backend: 'postgres'
  readonly image: typeof POSTGRES_IMAGE
  readonly uri: string
  readonly sql: SqlQuery
  readonly pool: Pool
  reset(): Promise<void>
  stop(): Promise<void>
}

export async function startPostgres(): Promise<StartedPostgres> {
  let container: StartedPostgreSqlContainer
  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('feed')
      .withUsername('feed')
      .withPassword('feed')
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' }) // throwaway catalog, skip disk WAL
      .start()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Postgres testcontainer (${POSTGRES_IMAGE}) failed to start. Docker must be running. ${detail}`,
    )
  }

  const uri = container.getConnectionUri()
  const pool = new Pool({
    connectionString: uri,
    max: POOL_MAX,
    allowExitOnIdle: true,
    idleTimeoutMillis: 1_000,
  })
  const sql = asSql(pool)
  let stopped = false

  return {
    backend: 'postgres',
    image: POSTGRES_IMAGE,
    uri,
    sql,
    pool,
    async reset() {
      await sql.query('TRUNCATE TABLE users CASCADE')
    },
    async stop() {
      if (stopped) return
      stopped = true
      try {
        await pool.end()
      } finally {
        await container.stop()
      }
    },
  }
}

function asSql(pool: Pool): SqlQuery {
  return {
    async query<T = Record<string, unknown>>(text: string, params?: unknown[]) {
      const result =
        params === undefined
          ? await pool.query<QueryResultRow>(text)
          : await pool.query<QueryResultRow>(text, params)
      return { rows: result.rows as T[] }
    },
  }
}
