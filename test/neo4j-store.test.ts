import { describe, expect, it } from 'vitest'
import { StoreError } from '../src/domain'
import { ConstraintError, CYPHER, MemoryGraph, Neo4jStore } from '../src/neo4j/store'
import { defineStoreContract } from './contract'

defineStoreContract('neo4j', () => Neo4jStore.create(new MemoryGraph()))

describe('neo4j property graph', () => {
  it('stores users and posts as nodes and follow/authored as directed edges', async () => {
    const g = new MemoryGraph()
    const store = await Neo4jStore.create(g)
    await store.createUser({ id: 'ada', handle: 'ada' }, 1)
    await store.createUser({ id: 'bob', handle: 'bob' }, 1)
    await store.follow('ada', 'bob')
    await store.publish({ id: 'p1', authorId: 'bob', body: 'hi' }, 4)

    expect(g.nodesWithLabel('User').map((n) => n.props.id).sort()).toEqual(['ada', 'bob'])
    expect(g.nodesWithLabel('Post').map((n) => n.props)).toEqual([
      { id: 'p1', body: 'hi', createdAt: 4 },
    ])
    expect(g.rels('FOLLOWS')).toEqual([{ type: 'FOLLOWS', fromId: 'ada', toId: 'bob' }])
    expect(g.rels('AUTHORED')).toEqual([{ type: 'AUTHORED', fromId: 'bob', toId: 'p1' }])
  })

  it('walks shortest FOLLOWS paths that SQL would need a recursive CTE for', async () => {
    const store = await Neo4jStore.create(new MemoryGraph())
    await seed(store, ['ada', 'bob', 'cam', 'dan'])
    await store.follow('ada', 'bob')
    await store.follow('bob', 'cam')
    await store.follow('cam', 'dan')
    await store.follow('ada', 'cam')
    expect(await store.shortestFollowPath('ada', 'dan')).toEqual(['ada', 'cam', 'dan'])
    expect(await store.shortestFollowPath('ada', 'bob')).toEqual(['ada', 'bob'])
    expect(await store.shortestFollowPath('dan', 'ada')).toBeNull()
    expect(await store.shortestFollowPath('ada', 'ada')).toBeNull()
    expect(CYPHER.shortestPath).toContain('shortestPath((a)-[:FOLLOWS*..16]->(b))')
  })

  it('ranks friend-of-friend recommendations by independent 2-hop paths', async () => {
    const store = await Neo4jStore.create(new MemoryGraph())
    await seed(store, ['ada', 'bob', 'cam', 'dan', 'eve'])
    await store.follow('ada', 'bob')
    await store.follow('ada', 'cam')
    await store.follow('bob', 'dan')
    await store.follow('cam', 'dan')
    await store.follow('bob', 'eve')
    await store.follow('ada', 'eve')
    expect(await store.recommendFollows('ada')).toEqual([{ id: 'dan', score: 2 }])
    expect(await store.recommendFollows('eve')).toEqual([])
    expect(CYPHER.recommend).toContain('NOT (u)-[:FOLLOWS]->(rec)')
  })

  it('matches a 2-cycle as mutual and intersection as common followees', async () => {
    const store = await Neo4jStore.create(new MemoryGraph())
    await seed(store, ['ada', 'bob', 'cam', 'dan'])
    await store.follow('ada', 'bob')
    await store.follow('bob', 'ada')
    await store.follow('ada', 'cam')
    await store.follow('bob', 'cam')
    await store.follow('bob', 'dan')
    expect(await store.isMutual('ada', 'bob')).toBe(true)
    expect(await store.isMutual('ada', 'cam')).toBe(false)
    expect(await store.commonFollowees('ada', 'bob')).toEqual(['cam'])
    expect(await store.commonFollowees('ada', 'dan')).toEqual([])
  })

  it('maps a driver-shaped unique constraint to handle_taken', async () => {
    const g = new MemoryGraph()
    const store = Neo4jStore.create(g)
    g.createNode = () => {
      throw {
        code: 'Neo.ClientError.Schema.ConstraintValidationFailed',
        constraint: 'user_handle',
      }
    }
    await expect(store.createUser({ id: 'ada', handle: 'ada' }, 1)).rejects.toMatchObject({
      constructor: StoreError,
      code: 'handle_taken',
    })
  })

  it('rejects a duplicate handle at the User.handle constraint', async () => {
    const g = new MemoryGraph()
    const store = Neo4jStore.create(g)
    await store.createUser({ id: 'u1', handle: 'ada' }, 1)
    await expect(store.createUser({ id: 'u2', handle: 'ada' }, 2)).rejects.toMatchObject({
      code: 'handle_taken',
    })
    expect(() => g.createNode(['User'], { id: 'u3', handle: 'ada', createdAt: 3 })).toThrow(
      ConstraintError,
    )
  })
})

async function seed(store: Neo4jStore, ids: string[]): Promise<void> {
  for (const id of ids) await store.createUser({ id, handle: id }, 1)
}
