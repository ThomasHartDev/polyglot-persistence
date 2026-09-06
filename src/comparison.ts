export const BACKENDS = [
  'postgres',
  'mongodb',
  'redis',
  'cassandra',
  'cockroach',
  'neo4j',
] as const

export type BackendId = (typeof BACKENDS)[number]

export const GUIDE_SHAPES = [
  'point_get',
  'author_timeline',
  'home_feed',
  'keyset_page',
  'publish',
  'hop_walk',
] as const

export type GuideShape = (typeof GUIDE_SHAPES)[number]
export type Pacelc = 'CA/EC' | 'CA/EL' | 'PA/EL' | 'PC/EC'
export type ConsistencyClass =
  | 'read_committed'
  | 'serializable'
  | 'linearizable_per_key'
  | 'tunable_quorum'
  | 'majority_session'
  | 'causal'
export type Uniqueness = 'constraint' | 'unique_index' | 'lwt' | 'setnx'
export type FeedShape = 'lateral_join' | 'in_filter' | 'n_zrange' | 'n_partitions' | 'two_hop'
export type Paradigm =
  | 'relational'
  | 'document'
  | 'key_value'
  | 'wide_column'
  | 'distributed_sql'
  | 'graph'

export interface BackendProfile {
  id: BackendId
  paradigm: Paradigm
  consistency: {
    class: ConsistencyClass
    pacelc: Pacelc
    crossKeyTxn: boolean
    uniqueness: Uniqueness
  }
  query: {
    feed: FeedShape
    adHocSql: boolean
    hops: boolean
    ttl: boolean
    native: readonly GuideShape[]
  }
  scale: { horizontal: boolean; durable: boolean; unit: string }
  opsCost: 1 | 2 | 3 | 4 | 5
  integrity: 1 | 2 | 3 | 4 | 5
  when: string
}

export interface StoreNeed {
  txn?: boolean
  hops?: boolean
  adHocSql?: boolean
  ttl?: boolean
  declarativeUniqueness?: boolean
  linearWrites?: boolean
  inMemory?: boolean
  preferConsistency?: boolean
  maxOpsCost?: number
  query?: GuideShape
}

export interface RankedPick {
  backend: BackendId
  score: number
  because: readonly string[]
}
export interface RejectedPick { backend: BackendId; because: string }
export interface Choice { ranked: RankedPick[]; rejected: RejectedPick[] }

const FEED: readonly GuideShape[] = GUIDE_SHAPES.filter((s) => s !== 'hop_walk')
const GRAPH: readonly GuideShape[] = GUIDE_SHAPES
const RANK: Record<ConsistencyClass, number> = {
  serializable: 5,
  linearizable_per_key: 4,
  causal: 3,
  majority_session: 3,
  read_committed: 2,
  tunable_quorum: 1,
}

export const PROFILES: readonly BackendProfile[] = [
  row('postgres', 'relational', 'read_committed', 'CA/EC', true, 'constraint', 'lateral_join', true, false, false, false, true, 'primary + replicas', 2, 5, 'Handles must be unique, the feed is a join, and one primary is enough.'),
  row('mongodb', 'document', 'majority_session', 'PC/EC', true, 'unique_index', 'in_filter', false, false, false, true, true, 'shard key', 3, 4, 'The user document is the read model and posts stay referenced under the 16 MiB cap.'),
  row('redis', 'key_value', 'linearizable_per_key', 'CA/EL', false, 'setnx', 'n_zrange', false, false, true, true, false, 'hash slot (memory)', 1, 2, 'The hot path is a HASH or ZSET and expiry is a first-class operation.'),
  row('cassandra', 'wide_column', 'tunable_quorum', 'PA/EL', false, 'lwt', 'n_partitions', false, false, false, true, true, 'partition', 4, 3, 'Author timelines scale by partition and every query is named up front.'),
  row('cockroach', 'distributed_sql', 'serializable', 'PC/EC', true, 'constraint', 'lateral_join', true, false, false, true, true, 'range + hash bucket', 5, 5, 'SQL uniqueness and SERIALIZABLE have to hold across ranges.'),
  row('neo4j', 'graph', 'causal', 'CA/EC', true, 'constraint', 'two_hop', false, true, false, false, true, 'min-cut (hard)', 4, 5, 'The question is a walk (shortest path, friend-of-friend), not a table scan.'),
]

export function profileOf(id: string): BackendProfile {
  const found = PROFILES.find((p) => p.id === id)
  if (!found) throw new RangeError('backend')
  return found
}

export function chooseStore(need: StoreNeed = {}): Choice {
  validateNeed(need)
  const ranked: RankedPick[] = []
  const rejected: RejectedPick[] = []
  for (const profile of PROFILES) {
    const reason = rejectReason(profile, need)
    if (reason) rejected.push({ backend: profile.id, because: reason })
    else {
      ranked.push({
        backend: profile.id,
        score: scoreProfile(profile, need),
        because: becauseOf(profile, need),
      })
    }
  }
  ranked.sort(compareRank)
  return { ranked, rejected }
}

export function scoreProfile(profile: BackendProfile, need: StoreNeed = {}): number {
  const query = need.query ?? 'home_feed'
  let score = profile.integrity + (6 - profile.opsCost)
  if (profile.query.native.includes(query)) score += 4
  if (need.preferConsistency) score += RANK[profile.consistency.class]
  if (need.linearWrites && profile.scale.horizontal) score += 3
  if (need.linearWrites && isFeed(query) && profile.paradigm === 'wide_column') score += 3
  if (need.linearWrites && profile.paradigm === 'distributed_sql' && !need.adHocSql && !need.txn) {
    score -= 1
  }
  if (need.txn && need.linearWrites && profile.paradigm === 'distributed_sql') score += 3
  if (need.hops && profile.query.hops) score += 5
  if (need.ttl && profile.query.ttl) score += 5
  return score
}

export function renderGuide(): string {
  return [
    '# When to use which store',
    '',
    'One activity feed. Six physical models. Filter on hard constraints first (transactions, hops, TTL, write scale), then rank what remains on integrity, native access, and ops cost.',
    '',
    'PACELC: if a partition, choose Availability or Consistency. Else choose Latency or Consistency.',
    '',
    '## Consistency',
    md(
      ['backend', 'class', 'PACELC', 'cross-key txn', 'uniqueness'],
      PROFILES.map((p) => [
        p.id,
        p.consistency.class,
        p.consistency.pacelc,
        yn(p.consistency.crossKeyTxn),
        p.consistency.uniqueness,
      ]),
    ),
    '',
    '## Query shape',
    md(
      ['backend', 'feed', 'ad-hoc SQL', 'hops', 'TTL'],
      PROFILES.map((p) => [
        p.id,
        p.query.feed,
        yn(p.query.adHocSql),
        yn(p.query.hops),
        yn(p.query.ttl),
      ]),
    ),
    '',
    '## Scaling',
    md(
      ['backend', 'horizontal', 'durable', 'unit'],
      PROFILES.map((p) => [
        p.id,
        yn(p.scale.horizontal),
        yn(p.scale.durable),
        p.scale.unit,
      ]),
    ),
    '',
    '## Operational cost',
    md(
      ['backend', 'cost', 'integrity', 'when'],
      PROFILES.map((p) => [p.id, String(p.opsCost), String(p.integrity), p.when]),
      [false, true, true, false],
    ),
  ].join('\n')
}

export function renderChoice(choice: Choice): string {
  const lines = [
    md(
      ['rank', 'backend', 'score', 'because'],
      choice.ranked.map((pick, i) => [
        String(i + 1),
        pick.backend,
        String(pick.score),
        pick.because.join('; '),
      ]),
      [true, false, true, false],
    ),
  ]
  if (choice.rejected.length > 0) {
    lines.push(
      '',
      md(
        ['backend', 'rejected'],
        choice.rejected.map((row) => [row.backend, row.because]),
      ),
    )
  }
  return lines.join('\n')
}

function row(
  id: BackendId,
  paradigm: Paradigm,
  klass: ConsistencyClass,
  pacelc: Pacelc,
  crossKeyTxn: boolean,
  uniqueness: Uniqueness,
  feed: FeedShape,
  adHocSql: boolean,
  hops: boolean,
  ttl: boolean,
  horizontal: boolean,
  durable: boolean,
  unit: string,
  opsCost: 1 | 2 | 3 | 4 | 5,
  integrity: 1 | 2 | 3 | 4 | 5,
  when: string,
): BackendProfile {
  return {
    id,
    paradigm,
    consistency: { class: klass, pacelc, crossKeyTxn, uniqueness },
    query: { feed, adHocSql, hops, ttl, native: hops ? GRAPH : FEED },
    scale: { horizontal, durable, unit },
    opsCost,
    integrity,
    when,
  }
}

function validateNeed(need: StoreNeed): void {
  const n = need.maxOpsCost
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 5)) {
    throw new RangeError('maxOpsCost')
  }
}

function rejectReason(profile: BackendProfile, need: StoreNeed): string | null {
  if (need.txn && !profile.consistency.crossKeyTxn) return 'no cross-key transaction'
  if ((need.hops || need.query === 'hop_walk') && !profile.query.hops) {
    return 'no variable-length path'
  }
  if (need.adHocSql && !profile.query.adHocSql) return 'no ad-hoc SQL'
  if (need.ttl && !profile.query.ttl) return 'no per-key TTL'
  const unique = profile.consistency.uniqueness
  if (need.declarativeUniqueness && (unique === 'lwt' || unique === 'setnx')) {
    return 'uniqueness is not declarative'
  }
  if (need.linearWrites) {
    const durable = profile.scale.durable || need.inMemory === true
    if (!(profile.scale.horizontal && durable)) return 'no durable horizontal write scale'
  }
  if (need.maxOpsCost !== undefined && profile.opsCost > need.maxOpsCost) {
    return 'ops cost exceeds ceiling'
  }
  return null
}

function becauseOf(profile: BackendProfile, need: StoreNeed): string[] {
  const query = need.query ?? 'home_feed'
  const reasons = [`PACELC ${profile.consistency.pacelc}`]
  if (profile.query.native.includes(query)) reasons.push(`native ${query}`)
  if (need.txn) reasons.push('cross-key txn')
  if (need.hops || query === 'hop_walk') reasons.push('variable-length path')
  if (need.ttl) reasons.push('per-key TTL')
  if (need.linearWrites) reasons.push(`scale ${profile.scale.unit}`)
  reasons.push(`integrity ${profile.integrity}`, `ops ${profile.opsCost}`)
  return reasons
}

function compareRank(a: RankedPick, b: RankedPick): number {
  if (a.score !== b.score) return b.score - a.score
  const ia = profileOf(a.backend).integrity - profileOf(b.backend).integrity
  if (ia !== 0) return -ia
  const oa = profileOf(a.backend).opsCost - profileOf(b.backend).opsCost
  if (oa !== 0) return oa
  return a.backend.localeCompare(b.backend)
}

function isFeed(query: GuideShape): boolean {
  return query === 'home_feed' || query === 'author_timeline'
}
function yn(value: boolean): string {
  return value ? 'yes' : 'no'
}

function md(
  headers: string[],
  rows: string[][],
  numeric: boolean[] = headers.map(() => false),
): string {
  const align = numeric.map((n) => (n ? '---:' : '---'))
  const head = `| ${headers.join(' | ')} |`
  const rule = `| ${align.join(' | ')} |`
  const body = rows.map((r) => `| ${r.join(' | ')} |`)
  return [head, rule, ...body].join('\n')
}
