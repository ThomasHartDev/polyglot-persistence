export class DuplicateKeyError extends Error {
  readonly code = 11000
  constructor(readonly keyPattern: Record<string, 1 | -1>) {
    super('E11000 duplicate key')
    this.name = 'DuplicateKeyError'
  }
}

export type Filter = Record<string, unknown>
export type Sort = Record<string, 1 | -1>
export type UpdateOp = {
  $addToSet?: Record<string, unknown>
  $pull?: Record<string, unknown>
}

export interface MongoCollection<T extends { _id: string }> {
  insertOne(doc: T): Promise<{ insertedId: string }>
  findOne(filter: Filter): Promise<T | null>
  find(filter: Filter, opts?: { sort?: Sort; limit?: number }): Promise<T[]>
  updateOne(filter: Filter, update: UpdateOp): Promise<{ matchedCount: number }>
  deleteOne(filter: Filter): Promise<{ deletedCount: number }>
  createIndex(key: Sort, opts?: { unique?: boolean; name?: string }): Promise<string>
}

export interface MongoDb {
  collection<T extends { _id: string }>(name: string): MongoCollection<T>
}

interface Index {
  name: string
  key: Sort
  unique: boolean
  seen: Map<string, string>
}

export class MemoryMongo implements MongoDb {
  private readonly cols = new Map<string, MemoryCollection>()

  collection<T extends { _id: string }>(name: string): MongoCollection<T> {
    const col = this.cols.get(name) ?? new MemoryCollection()
    this.cols.set(name, col)
    return col as unknown as MongoCollection<T>
  }
}

class MemoryCollection<T extends { _id: string } = { _id: string }> {
  private readonly docs = new Map<string, T>()
  private readonly indexes: Index[] = []

  async insertOne(doc: T): Promise<{ insertedId: string }> {
    if (this.docs.has(doc._id)) throw new DuplicateKeyError({ _id: 1 })
    const clone = structuredClone(doc)
    for (const idx of this.indexes) {
      if (!idx.unique) continue
      const k = indexKey(clone, idx.key)
      if (idx.seen.has(k)) throw new DuplicateKeyError(idx.key)
    }
    this.docs.set(clone._id, clone)
    for (const idx of this.indexes) {
      if (idx.unique) idx.seen.set(indexKey(clone, idx.key), clone._id)
    }
    return { insertedId: clone._id }
  }

  async findOne(filter: Filter): Promise<T | null> {
    const [doc] = await this.find(filter, { limit: 1 })
    return doc ?? null
  }

  async find(filter: Filter, opts?: { sort?: Sort; limit?: number }): Promise<T[]> {
    const out: T[] = []
    for (const doc of this.docs.values()) {
      if (matches(doc, filter)) out.push(structuredClone(doc))
    }
    if (opts?.sort) {
      const sort = opts.sort
      out.sort((a, b) => compareDocs(a, b, sort))
    }
    return opts?.limit === undefined ? out : out.slice(0, Math.max(0, opts.limit))
  }

  async updateOne(filter: Filter, update: UpdateOp): Promise<{ matchedCount: number }> {
    for (const doc of this.docs.values()) {
      if (!matches(doc, filter)) continue
      applyUpdate(doc as Record<string, unknown>, update)
      return { matchedCount: 1 }
    }
    return { matchedCount: 0 }
  }

  async deleteOne(filter: Filter): Promise<{ deletedCount: number }> {
    for (const doc of this.docs.values()) {
      if (!matches(doc, filter)) continue
      this.docs.delete(doc._id)
      for (const idx of this.indexes) {
        if (idx.unique) idx.seen.delete(indexKey(doc, idx.key))
      }
      return { deletedCount: 1 }
    }
    return { deletedCount: 0 }
  }

  async createIndex(key: Sort, opts?: { unique?: boolean; name?: string }): Promise<string> {
    const name = opts?.name ?? Object.keys(key).join('_')
    if (this.indexes.some((idx) => idx.name === name)) return name
    const seen = new Map<string, string>()
    if (opts?.unique) {
      for (const doc of this.docs.values()) {
        const k = indexKey(doc, key)
        if (seen.has(k)) throw new DuplicateKeyError(key)
        seen.set(k, doc._id)
      }
    }
    this.indexes.push({ name, key, unique: opts?.unique === true, seen })
    return name
  }
}

function indexKey(doc: object, key: Sort): string {
  const rec = doc as Record<string, unknown>
  return Object.keys(key).map((field) => String(rec[field] ?? '')).join('\x1f')
}

function isOp(pred: unknown): pred is Record<string, unknown> {
  return typeof pred === 'object' && pred !== null && !Array.isArray(pred)
}

function matches(doc: object, filter: Filter): boolean {
  const rec = doc as Record<string, unknown>
  for (const [key, pred] of Object.entries(filter)) {
    if (key === '$or') {
      if (!(pred as Filter[]).some((clause) => matches(doc, clause))) return false
      continue
    }
    const value = rec[key]
    if (isOp(pred) && ('$in' in pred || '$lt' in pred)) {
      if ('$in' in pred) {
        if (!Array.isArray(pred.$in) || !pred.$in.includes(value)) return false
        continue
      }
      if (!lt(value, pred.$lt)) return false
      continue
    }
    if (value !== pred) return false
  }
  return true
}

function lt(value: unknown, bound: unknown): boolean {
  return (
    (typeof value === 'number' && typeof bound === 'number' && value < bound) ||
    (typeof value === 'string' && typeof bound === 'string' && value < bound)
  )
}

function compareDocs(a: object, b: object, sort: Sort): number {
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  for (const [field, dir] of Object.entries(sort)) {
    const av = left[field]
    const bv = right[field]
    if (av === bv) continue
    if (av === undefined) return 1
    if (bv === undefined) return -1
    return ((av as string | number) < (bv as string | number) ? -1 : 1) * dir
  }
  return 0
}

function applyUpdate(doc: Record<string, unknown>, update: UpdateOp): void {
  for (const [field, value] of Object.entries(update.$addToSet ?? {})) {
    const cur = doc[field]
    const arr = Array.isArray(cur) ? cur : []
    if (!arr.includes(value)) doc[field] = [...arr, value]
  }
  for (const [field, value] of Object.entries(update.$pull ?? {})) {
    const cur = doc[field]
    if (Array.isArray(cur)) doc[field] = cur.filter((item) => item !== value)
  }
}
