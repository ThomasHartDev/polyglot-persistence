export interface RedisCommands {
  get(key: string): Promise<string | null>
  set(key: string, value: string, opts?: { nx?: boolean }): Promise<boolean>
  del(...keys: string[]): Promise<number>
  hset(key: string, fields: Record<string, string>): Promise<number>
  hsetnx(key: string, field: string, value: string): Promise<boolean>
  hgetall(key: string): Promise<Record<string, string>>
  sadd(key: string, member: string): Promise<number>
  srem(key: string, member: string): Promise<number>
  sismember(key: string, member: string): Promise<boolean>
  smembers(key: string): Promise<string[]>
  zadd(key: string, score: number, member: string): Promise<number>
  zrem(key: string, member: string): Promise<number>
  zcard(key: string): Promise<number>
  zrevrangebyscore(
    key: string,
    max: number,
    min: number,
  ): Promise<Array<{ member: string; score: number }>>
  pexpire(key: string, ttlMs: number): Promise<boolean>
  pttl(key: string): Promise<number>
}

type Rec =
  | { t: 'string'; v: string; exp?: number }
  | { t: 'hash'; v: Map<string, string>; exp?: number }
  | { t: 'set'; v: Set<string>; exp?: number }
  | { t: 'zset'; v: Map<string, number>; exp?: number }

export class MemoryRedis implements RedisCommands {
  private readonly keys = new Map<string, Rec>()

  constructor(private readonly clock: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const rec = this.as(key, 'string')
    return rec ? rec.v : null
  }

  async set(key: string, value: string, opts?: { nx?: boolean }): Promise<boolean> {
    const live = this.alive(key)
    if (opts?.nx && live) return false
    if (live && live.t !== 'string') throw new Error('WRONGTYPE')
    this.keys.set(key, { t: 'string', v: value })
    return true
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0
    for (const key of keys) {
      if (this.alive(key)) n++
      this.keys.delete(key)
    }
    return n
  }

  async hset(key: string, fields: Record<string, string>): Promise<number> {
    const rec = this.ensure(key, 'hash', () => ({ t: 'hash', v: new Map() }))
    let added = 0
    for (const [field, value] of Object.entries(fields)) {
      if (!rec.v.has(field)) added++
      rec.v.set(field, value)
    }
    return added
  }

  async hsetnx(key: string, field: string, value: string): Promise<boolean> {
    const rec = this.ensure(key, 'hash', () => ({ t: 'hash', v: new Map() }))
    if (rec.v.has(field)) return false
    rec.v.set(field, value)
    return true
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const rec = this.as(key, 'hash')
    if (!rec) return {}
    return Object.fromEntries(rec.v)
  }

  async sadd(key: string, member: string): Promise<number> {
    const rec = this.ensure(key, 'set', () => ({ t: 'set', v: new Set() }))
    const before = rec.v.size
    rec.v.add(member)
    return rec.v.size - before
  }

  async srem(key: string, member: string): Promise<number> {
    const rec = this.as(key, 'set')
    if (!rec) return 0
    return rec.v.delete(member) ? 1 : 0
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const rec = this.as(key, 'set')
    return rec ? rec.v.has(member) : false
  }

  async smembers(key: string): Promise<string[]> {
    const rec = this.as(key, 'set')
    return rec ? [...rec.v] : []
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const rec = this.ensure(key, 'zset', () => ({ t: 'zset', v: new Map() }))
    const added = rec.v.has(member) ? 0 : 1
    rec.v.set(member, score)
    return added
  }

  async zrem(key: string, member: string): Promise<number> {
    const rec = this.as(key, 'zset')
    if (!rec) return 0
    return rec.v.delete(member) ? 1 : 0
  }

  async zcard(key: string): Promise<number> {
    const rec = this.as(key, 'zset')
    return rec ? rec.v.size : 0
  }

  async zrevrangebyscore(
    key: string,
    max: number,
    min: number,
  ): Promise<Array<{ member: string; score: number }>> {
    const rec = this.as(key, 'zset')
    if (!rec) return []
    return [...rec.v.entries()]
      .filter(([, score]) => score <= max && score >= min)
      .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? 1 : -1) : b[1] - a[1]))
      .map(([member, score]) => ({ member, score }))
  }

  async pexpire(key: string, ttlMs: number): Promise<boolean> {
    const rec = this.alive(key)
    if (!rec || ttlMs < 1) return false
    rec.exp = this.clock() + ttlMs
    return true
  }

  async pttl(key: string): Promise<number> {
    const rec = this.alive(key)
    if (!rec) return -2
    if (rec.exp === undefined) return -1
    return Math.max(0, rec.exp - this.clock())
  }

  private alive(key: string): Rec | undefined {
    const rec = this.keys.get(key)
    if (!rec) return undefined
    if (rec.exp !== undefined && rec.exp <= this.clock()) {
      this.keys.delete(key)
      return undefined
    }
    return rec
  }

  private as<T extends Rec['t']>(key: string, t: T): Extract<Rec, { t: T }> | undefined {
    const rec = this.alive(key)
    if (!rec) return undefined
    if (rec.t !== t) throw new Error('WRONGTYPE')
    return rec as Extract<Rec, { t: T }>
  }

  private ensure<T extends Rec['t']>(
    key: string,
    t: T,
    make: () => Extract<Rec, { t: T }>,
  ): Extract<Rec, { t: T }> {
    const rec = this.as(key, t)
    if (rec) return rec
    const created = make()
    this.keys.set(key, created)
    return created
  }
}
