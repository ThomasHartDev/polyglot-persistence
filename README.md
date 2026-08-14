# polyglot-persistence

One domain, many stores: the same activity feed modeled on relational, document, key-value, wide-column, distributed SQL, and graph databases, with the tradeoffs written down.

## What this demonstrates

Polyglot persistence is the idea that one product rarely has one ideal database. A follow graph wants adjacency lookups, a home timeline wants a clustered time key, and a unique handle wants a relational constraint. This repo keeps one domain and one `ActivityStore` port, then implements that port on each paradigm so query shape, consistency, and scaling stay comparable. The first backend is in-memory fan-in-on-read: per-author timelines merged into a home feed. Later backends (Postgres, Redis, MongoDB, Cassandra, CockroachDB, Neo4j) keep the same interface and the same contract tests.

## Concepts demonstrated

- Polyglot persistence (one domain, several physical models)
- Repository / ports-and-adapters: `ActivityStore` is the port every backend implements
- Shared contract tests that pin behavior independent of the engine
- Fan-in on read (merge followee timelines) versus fan-out on write (per-follower inbox)
- K-way merge of sorted per-author timelines
- Compound cursor pagination over a total order `(createdAt DESC, id DESC)`
- Unique constraints on user id and handle
- Directed follow graph with idempotent edges and live (not snapshot) feeds

## What's implemented

- Project scaffold with TypeScript strict mode, Vitest, and CI
- Activity-feed domain, `ActivityStore` port, in-memory backend, and a shared contract suite

## Usage

```ts
import { MemoryStore } from 'polyglot-persistence'

const store = new MemoryStore()

await store.createUser({ id: 'ada', handle: 'ada' })
await store.createUser({ id: 'bob', handle: 'bob' })
await store.follow('ada', 'bob')

const post = await store.publish(
  { id: 'p1', authorId: 'bob', body: 'shipping the feed contract' },
  Date.now(),
)

const page = await store.feed('ada', { limit: 20 })
const next = await store.feed('ada', { limit: 20, before: post })
```

A new backend implements `ActivityStore` and calls `defineStoreContract(name, factory)` from `test/contract.ts`. If the contract is green, the store matches the domain.

## Running the tests

```sh
pnpm install
pnpm test
```

Type-check with `pnpm run typecheck`.

## License

MIT
