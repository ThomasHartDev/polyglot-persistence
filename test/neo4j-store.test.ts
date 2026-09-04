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
  })

  it('caps shortest FOLLOWS walks at 16 hops', async () => {
    const store = Neo4jStore.create(new MemoryGraph())
    const chain = Array.from({ length: 18 }, (_, i) => `u${String(i).padStart(2, '0')}`)
    await seed(store, chain)
    for (let i = 0; i < 17; i++) {
      const from = chain[i]
      const to = chain[i + 1]
      if (from && to) await store.follow(from, to)
    }
    expect(await store.shortestFollowPath('u00', 'u16')).toEqual(chain.slice(0, 17))
    expect(await store.shortestFollowPath('u00', 'u17')).toBeNull()
  })

  it('ranks friend-of-friend recommendations by independent 2-hop paths', async () => {
    const store = await Neo4jStore.create(new MemoryGraph())
    await seed(store, ['ada', 'bob', 'cam', 'dan', 'eve', 'fay', 'guy'])
    await store.follow('ada', 'bob')
    await store.follow('ada', 'cam')
    await store.follow('ada', 'dan')
    await store.follow('bob', 'eve')
    await store.follow('bob', 'fay')
    await store.follow('cam', 'fay')
    await store.follow('cam', 'guy')
    await store.follow('dan', 'guy')
    expect(await store.recommendFollows('ada')).toEqual([
      { id: 'fay', score: 2 },
      { id: 'guy', score: 2 },
      { id: 'eve', score: 1 },
    ])
    expect(await store.recommendFollows('eve')).toEqual([])
  })

  it('pins the Cypher catalog that a driver would run', () => {
    expect(CYPHER.follow).toBe(
      'MATCH (a:User {id: $from}), (b:User {id: $to}) WHERE a <> b MERGE (a)-[:FOLLOWS]->(b)',
    )
    expect(CYPHER.feed).toBe(
      'MATCH (u:User {id: $userId})-[:FOLLOWS]->(a:User)-[:AUTHORED]->(p:Post) RETURN p.id AS id, a.id AS authorId, p.body AS body, p.createdAt AS createdAt ORDER BY p.createdAt DESC, p.id DESC LIMIT $limit',
    )
    expect(CYPHER.feedBefore).toBe(
      'MATCH (u:User {id: $userId})-[:FOLLOWS]->(a:User)-[:AUTHORED]->(p:Post) WHERE p.createdAt < $createdAt OR (p.createdAt = $createdAt AND p.id < $postId) RETURN p.id AS id, a.id AS authorId, p.body AS body, p.createdAt AS createdAt ORDER BY p.createdAt DESC, p.id DESC LIMIT $limit',
    )
    expect(CYPHER.shortestPath).toBe(
      'MATCH (a:User {id: $from}), (b:User {id: $to}) MATCH path = shortestPath((a)-[:FOLLOWS*..16]->(b)) RETURN [n IN nodes(path) | n.id] AS ids',
    )
    expect(CYPHER.recommend).toBe(
      'MATCH (u:User {id: $id})-[:FOLLOWS]->()-[:FOLLOWS]->(rec:User) WHERE rec.id <> $id AND NOT (u)-[:FOLLOWS]->(rec) RETURN rec.id AS id, count(*) AS score ORDER BY score DESC, rec.id LIMIT $limit',
    )
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

  it('maps a MemoryGraph unique constraint to handle_taken', async () => {
    const g = new MemoryGraph()
    const store = Neo4jStore.create(g)
    g.createNode = () => {
      throw new ConstraintError('user_handle')
    }
    await expect(store.createUser({ id: 'ada', handle: 'ada' }, 1)).rejects.toMatchObject({
      constructor: StoreError,
      code: 'handle_taken',
    })
  })

  it('maps a driver Neo4jError message with no constraint field to handle_taken', async () => {
    const g = new MemoryGraph()
    const store = Neo4jStore.create(g)
    g.createNode = () => {
      throw {
        code: 'Neo.ClientError.Schema.ConstraintValidationFailed',
        message: "Node(123) already exists with label `User` and property `handle` = 'ada'",
      }
    }
    await expect(store.createUser({ id: 'ada', handle: 'ada' }, 1)).rejects.toMatchObject({
      constructor: StoreError,
      code: 'handle_taken',
    })
  })

  it('maps driver Neo4jError messages for User.id and Post.id', async () => {
    const g = new MemoryGraph()
    const store = Neo4jStore.create(g)
    await store.createUser({ id: 'ada', handle: 'ada' }, 1)
    g.createNode = () => {
      throw {
        code: 'Neo.ClientError.Schema.ConstraintValidationFailed',
        message: "Node(1) already exists with label `User` and property `id` = 'ada'",
      }
    }
    await expect(store.createUser({ id: 'ada', handle: 'other' }, 2)).rejects.toMatchObject({
      constructor: StoreError,
      code: 'user_exists',
    })
    g.createNode = () => {
      throw {
        code: 'Neo.ClientError.Schema.ConstraintValidationFailed',
        message: "Node(2) already exists with label `Post` and property `id` = 'p1'",
      }
    }
    await expect(store.publish({ id: 'p1', authorId: 'ada', body: 'hi' }, 3)).rejects.toMatchObject({
      constructor: StoreError,
      code: 'post_exists',
    })
  })

  it('rejects a FOLLOWS self-loop at the graph even when the store is skipped', () => {
    const g = new MemoryGraph()
    const ada = g.createNode(['User'], { id: 'ada', handle: 'ada', createdAt: 1 })
    expect(() => g.mergeRel(ada, 'FOLLOWS', ada)).toThrow('follows_no_self')
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
