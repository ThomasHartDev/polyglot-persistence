import { describe, expect, it } from 'vitest'
import {
  BACKENDS,
  chooseStore,
  GUIDE_SHAPES,
  PROFILES,
  profileOf,
  renderChoice,
  renderGuide,
  scoreProfile,
  type BackendId,
  type StoreNeed,
} from '../src/comparison'

describe('catalog', () => {
  it('covers each backend once and pins PACELC plus native access', () => {
    expect(PROFILES.map((p) => p.id)).toEqual([...BACKENDS])
    expect(new Set(PROFILES.map((p) => p.paradigm)).size).toBe(6)
    for (const profile of PROFILES) {
      expect(profile.opsCost).toBeGreaterThanOrEqual(1)
      expect(profile.opsCost).toBeLessThanOrEqual(5)
      expect(profile.when.length).toBeGreaterThan(20)
    }
    expect(() => profileOf('mysql')).toThrow(RangeError)
    expect(profileOf('postgres').consistency).toMatchObject({
      class: 'read_committed',
      pacelc: 'CA/EC',
      crossKeyTxn: true,
      uniqueness: 'constraint',
    })
    expect(profileOf('mongodb').consistency.pacelc).toBe('PC/EC')
    expect(profileOf('redis').consistency).toMatchObject({
      class: 'linearizable_per_key',
      pacelc: 'CA/EL',
      uniqueness: 'setnx',
      crossKeyTxn: false,
    })
    expect(profileOf('cassandra').consistency).toMatchObject({
      class: 'tunable_quorum',
      pacelc: 'PA/EL',
      uniqueness: 'lwt',
      crossKeyTxn: false,
    })
    expect(profileOf('cockroach').consistency).toMatchObject({
      class: 'serializable',
      pacelc: 'PC/EC',
    })
    expect(profileOf('neo4j').query.native).toEqual([...GUIDE_SHAPES])
    for (const id of BACKENDS) {
      if (id === 'neo4j') continue
      expect(profileOf(id).query.native).not.toContain('hop_walk')
      expect(profileOf(id).query.ttl).toBe(id === 'redis')
    }
    expect(profileOf('postgres').scale.horizontal).toBe(false)
    expect(profileOf('redis').scale.durable).toBe(false)
  })
})

describe('chooseStore', () => {
  it('defaults to postgres and treats hops, TTL, SQL, and scale as hard filters', () => {
    expect(chooseStore().ranked[0]?.backend).toBe('postgres')
    expect(chooseStore().rejected).toEqual([])
    expect(ids(chooseStore({ hops: true }).ranked)).toEqual(['neo4j'])
    expect(chooseStore({ query: 'hop_walk' }).ranked[0]?.backend).toBe('neo4j')
    expect(ids(chooseStore({ ttl: true }).ranked)).toEqual(['redis'])
    expect(chooseStore({ hops: true, ttl: true }).ranked).toEqual([])
    expect(rejectMap({ hops: true, ttl: true })).toMatchObject({
      neo4j: 'no per-key TTL',
      redis: 'no variable-length path',
      postgres: 'no variable-length path',
    })
    expect(ids(chooseStore({ txn: true, adHocSql: true, linearWrites: true }).ranked)).toEqual([
      'cockroach',
    ])
    expect(chooseStore({ linearWrites: true }).ranked[0]?.backend).toBe('cassandra')
    expect(chooseStore({ txn: true, linearWrites: true }).ranked[0]?.backend).toBe('cockroach')
    expect(rejectMap({ linearWrites: true })).toMatchObject({
      postgres: 'no durable horizontal write scale',
      neo4j: 'no durable horizontal write scale',
      redis: 'no durable horizontal write scale',
    })
    expect(ids(chooseStore({ linearWrites: true, inMemory: true }).ranked)).toEqual(
      expect.arrayContaining(['redis', 'cassandra', 'mongodb', 'cockroach']),
    )
  })

  it('caps ops cost, rejects SET NX / LWT when uniqueness must be declarative, and tie-breaks', () => {
    expect(ids(chooseStore({ txn: true, adHocSql: true, maxOpsCost: 2 }).ranked)).toEqual([
      'postgres',
    ])
    expect(ids(chooseStore({ maxOpsCost: 1 }).ranked)).toEqual(['redis'])
    expect(rejectMap({ maxOpsCost: 1 }).postgres).toBe('ops cost exceeds ceiling')
    const unique = chooseStore({ declarativeUniqueness: true })
    expect(ids(unique.ranked)).toEqual(
      expect.arrayContaining(['postgres', 'mongodb', 'cockroach', 'neo4j']),
    )
    expect(rejectMap({ declarativeUniqueness: true })).toMatchObject({
      redis: 'uniqueness is not declarative',
      cassandra: 'uniqueness is not declarative',
    })
    expect(() => chooseStore({ maxOpsCost: 0 })).toThrow(RangeError)
    expect(() => chooseStore({ maxOpsCost: 1.5 })).toThrow(RangeError)
    expect(() => chooseStore({ maxOpsCost: 6 })).toThrow(RangeError)
    expect(chooseStore({ preferConsistency: true }).ranked[0]?.backend).toBe('postgres')
    expect(
      scoreProfile(profileOf('postgres'), { preferConsistency: true }),
    ).toBeGreaterThanOrEqual(
      scoreProfile(profileOf('cockroach'), { preferConsistency: true }),
    )
  })
})

describe('guide', () => {
  it('renders four axes, ranked picks, and an empty-choice header', () => {
    const md = renderGuide()
    for (const heading of [
      '# When to use which store',
      '## Consistency',
      '## Query shape',
      '## Scaling',
      '## Operational cost',
      'PACELC',
    ]) {
      expect(md).toContain(heading)
    }
    for (const id of BACKENDS) expect(md).toContain(`| ${id} |`)
    const hops = chooseStore({ hops: true })
    const table = renderChoice(hops)
    expect(table).toContain('| 1 | neo4j |')
    expect(table).toContain('| postgres | no variable-length path |')
    expect(hops.ranked[0]?.because).toEqual(
      expect.arrayContaining(['PACELC CA/EC', 'native home_feed', 'variable-length path']),
    )
    expect(renderChoice({ ranked: [], rejected: [] })).toBe(
      '| rank | backend | score | because |\n| ---: | --- | ---: | --- |',
    )
  })
})

function ids(ranked: { backend: BackendId }[]): BackendId[] {
  return ranked.map((row) => row.backend)
}

function rejectMap(need: StoreNeed): Record<string, string> {
  return Object.fromEntries(chooseStore(need).rejected.map((row) => [row.backend, row.because]))
}
