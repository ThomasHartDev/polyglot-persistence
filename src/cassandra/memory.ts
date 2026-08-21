export type CqlType = 'text' | 'bigint'
export type Cell = string | number
export type Row = Record<string, Cell>

export interface TableSchema {
  readonly name: string
  readonly columns: Readonly<Record<string, CqlType>>
  readonly partition: readonly string[]
  readonly clustering: readonly string[]
  readonly clusteringDesc: readonly boolean[]
}

function tbl(
  name: string,
  columns: Readonly<Record<string, CqlType>>,
  partition: readonly string[],
  clustering: readonly string[] = [],
  clusteringDesc: readonly boolean[] = [],
): TableSchema {
  return { name, columns, partition, clustering, clusteringDesc }
}

export const TABLES = {
  usersById: tbl('users_by_id', { user_id: 'text', handle: 'text', created_at: 'bigint' }, ['user_id']),
  usersByHandle: tbl('users_by_handle', { handle: 'text', user_id: 'text', created_at: 'bigint' }, ['handle']),
  followingByUser: tbl('following_by_user', { follower_id: 'text', followee_id: 'text' }, ['follower_id'], ['followee_id'], [false]),
  followersByUser: tbl('followers_by_user', { followee_id: 'text', follower_id: 'text' }, ['followee_id'], ['follower_id'], [false]),
  postsByAuthor: tbl(
    'posts_by_author',
    { author_id: 'text', created_at: 'bigint', post_id: 'text', body: 'text' },
    ['author_id'],
    ['created_at', 'post_id'],
    [true, true],
  ),
  postsById: tbl('posts_by_id', { post_id: 'text', author_id: 'text', body: 'text', created_at: 'bigint' }, ['post_id']),
} as const satisfies Record<string, TableSchema>

export const TABLE_LIST: readonly TableSchema[] = Object.values(TABLES)

export function toCreateCql(t: TableSchema): string {
  const pkSet = new Set([...t.partition, ...t.clustering])
  const extra = Object.keys(t.columns).filter((c) => !pkSet.has(c))
  const cols = [...t.partition, ...t.clustering, ...extra].map((name) => {
    const ty = t.columns[name]
    if (!ty) throw new Error(`unknown column ${name}`)
    return `${name} ${ty}`
  })
  const pk =
    t.clustering.length === 0
      ? (t.partition[0] ?? '')
      : `(${t.partition.join(', ')}), ${t.clustering.join(', ')}`
  const order = t.clustering
    .map((col, i) => `${col} ${t.clusteringDesc[i] ? 'DESC' : 'ASC'}`)
    .join(', ')
  const clustering = order ? ` WITH CLUSTERING ORDER BY (${order})` : ''
  return `CREATE TABLE ${t.name} (${cols.join(', ')}, PRIMARY KEY (${pk}))${clustering}`
}

export class InvalidQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidQueryError'
  }
}

export interface SelectOpts {
  eq: Record<string, Cell>
  clusteringLt?: Record<string, Cell>
  limit?: number
}

export class MemoryCassandra {
  private readonly tables = new Map<string, Map<string, Row[]>>()
  private readonly schemas = new Map<string, TableSchema>()

  constructor() {
    for (const t of TABLE_LIST) {
      this.schemas.set(t.name, t)
      this.tables.set(t.name, new Map())
    }
  }

  insert(table: string, row: Row, opts?: { ifNotExists?: boolean }): { applied: boolean } {
    const schema = this.must(table)
    const key = partitionKey(schema, row)
    const copy = { ...row }
    const parts = this.tables.get(table)
    if (!parts) throw new InvalidQueryError(`unknown table ${table}`)
    let rows = parts.get(key)
    if (!rows) {
      rows = []
      parts.set(key, rows)
    }
    const idx = rows.findIndex((existing) => sameCk(schema, existing, copy))
    if (idx >= 0) {
      if (opts?.ifNotExists) return { applied: false }
      rows[idx] = copy
      return { applied: true }
    }
    let lo = 0
    let hi = rows.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const at = rows[mid]
      if (at !== undefined && compareClustering(schema, at, copy) <= 0) lo = mid + 1
      else hi = mid
    }
    rows.splice(lo, 0, copy)
    return { applied: true }
  }

  select(table: string, opts: SelectOpts): Row[] {
    const schema = this.must(table)
    for (const col of Object.keys(opts.eq)) {
      if (!schema.partition.includes(col) && !schema.clustering.includes(col)) {
        throw new InvalidQueryError(`cannot restrict ${col} on ${table}`)
      }
    }
    for (const col of schema.partition) {
      if (!(col in opts.eq)) throw new InvalidQueryError(`missing partition key ${col}`)
    }
    const bound = opts.clusteringLt
    if (bound) {
      for (const col of Object.keys(bound)) {
        if (!schema.clustering.includes(col)) throw new InvalidQueryError(`cannot range ${col} on ${table}`)
      }
    }
    const part = this.tables.get(table)?.get(partitionKey(schema, opts.eq)) ?? []
    const eqCk = schema.clustering.filter((c) => c in opts.eq)
    let rows = part.filter((row) => eqCk.every((c) => row[c] === opts.eq[c]))
    if (bound) rows = rows.filter((row) => naturallyLess(schema, row, bound))
    if (opts.limit !== undefined) rows = rows.slice(0, Math.max(0, opts.limit))
    return rows.map((row) => ({ ...row }))
  }

  delete(table: string, where: Record<string, Cell>): void {
    const schema = this.must(table)
    const parts = this.tables.get(table)
    if (!parts) return
    const key = partitionKey(schema, where)
    const rows = parts.get(key)
    if (!rows) return
    const ck = schema.clustering.filter((c) => c in where)
    if (ck.length === 0) {
      parts.delete(key)
      return
    }
    const next = rows.filter((row) => !ck.every((c) => row[c] === where[c]))
    if (next.length === 0) parts.delete(key)
    else parts.set(key, next)
  }

  partitionCount(table: string): number {
    return this.tables.get(table)?.size ?? 0
  }

  private must(table: string): TableSchema {
    const schema = this.schemas.get(table)
    if (!schema) throw new InvalidQueryError(`unknown table ${table}`)
    return schema
  }
}

function partitionKey(schema: TableSchema, row: Record<string, Cell>): string {
  return schema.partition
    .map((col) => {
      if (!(col in row)) throw new InvalidQueryError(`missing partition key ${col}`)
      return String(row[col])
    })
    .join('\x1f')
}

function sameCk(schema: TableSchema, a: Row, b: Row): boolean {
  return schema.clustering.every((c) => a[c] === b[c])
}

function compareCell(a: Cell | undefined, b: Cell | undefined): number {
  if (a === b) return 0
  if (a === undefined) return -1
  if (b === undefined) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a) < String(b) ? -1 : 1
}

function compareClustering(schema: TableSchema, a: Row, b: Row): number {
  for (let i = 0; i < schema.clustering.length; i++) {
    const col = schema.clustering[i]
    if (!col) continue
    const c = compareCell(a[col], b[col])
    if (c !== 0) return schema.clusteringDesc[i] ? -c : c
  }
  return 0
}

function naturallyLess(schema: TableSchema, row: Row, bound: Record<string, Cell>): boolean {
  for (const col of schema.clustering) {
    if (!(col in bound)) continue
    const c = compareCell(row[col], bound[col])
    if (c !== 0) return c < 0
  }
  return false
}
