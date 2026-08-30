# polyglot-persistence

One domain, many stores: the same activity feed modeled on relational, document, key-value, wide-column, distributed SQL, and graph databases, with the tradeoffs written down.

## What this demonstrates

Polyglot persistence is the idea that one product rarely has one ideal database. A follow graph wants adjacency lookups, a home timeline wants a clustered time key, and a unique handle wants a relational constraint. This repo keeps one domain and one `ActivityStore` port, then implements that port on each paradigm so query shape, consistency, and scaling stay comparable. The in-memory backend is fan-in on read: per-author timelines merged into a home feed. The Postgres backend is the same port over a 3NF schema, composite B-tree indexes, and keyset SQL. The Redis backend speaks HASH, SET, ZSET, and SET NX, plus per-key PEXPIRE. Later backends (MongoDB, Cassandra, CockroachDB, Neo4j) keep the same interface and the same contract tests.

## Concepts demonstrated

- Polyglot persistence (one domain, several physical models)
- Repository / ports-and-adapters: `ActivityStore` is the port every backend implements
- Shared contract tests that pin behavior independent of the engine
- Fan-in on read (merge followee timelines) versus fan-out on write (per-follower inbox)
- K-way merge of sorted per-author timelines
- Compound cursor pagination over a total order `(createdAt DESC, id DESC)`
- Unique constraints on user id and handle
- Directed follow graph with idempotent edges and live (not snapshot) feeds
- Third normal form: users, a composite follow edge, posts
- Composite B-tree indexes `(author_id, created_at DESC, id DESC)` for a newest-first timeline
- Keyset pagination with a row comparison `(created_at, id) < cursor` (first page and keyed page are separate statements)
- Fan-in via `CROSS JOIN LATERAL`: each followee's newest-N posts walk `posts_author_timeline_idx`, then the outer query merges
- Table-level `CHECK` (no self-follow) and `UNIQUE` (handle) as the source of integrity
- Query planner: after `ANALYZE`, `EXPLAIN` on the author timeline is `Index Scan using posts_author_timeline_idx` with no Sort. The lateral feed uses that same scan per followee.
- Redis key design: `u:{id}` HASH, `h:{handle}` STRING, `p:{id}` HASH, `tl:{author}` ZSET, `fg:{id}` / `fr:{id}` SET
- SET NX as an application uniqueness primitive; sorted-set timeline (score = `createdAt`, member = post id, equal scores reverse-lex)
- Per-key TTL (`PEXPIRE`) versus a relational `PRIMARY KEY`: the hash can vanish, the ZSET member lingers until the next read `ZREM`s it, and the id is reusable
- No foreign keys and no `CHECK`: self-follow and existence are enforced in the store, not the engine

- Embedding vs referencing: `following[]` lives on the user document; posts and inbound follow edges are their own collections
- 16 MiB BSON document limit: unbounded posts are never nested under the author
- Dual-write follow: `$addToSet` / `$pull` on embedded `following[]` for the feed `$in` path; unique `{ followerId, followeeId }` edges answer `followers()`. `isFollowing()` reads the edge; `following()` and `feed()` read the embed. A missed embed is repaired on the next follow; until then the two sources can disagree.
- Unique index on `handle` (`E11000` / code 11000)
- Compound keyset via `$or` (`createdAt $lt`, or same `createdAt` and `_id $lt`); feed is `posts.find({ authorId: { $in: following } })`. Empty `$in` matches nothing.
- Query-first data modeling (Cassandra / CQL): one table per query, denormalized writes, no joins
- Partition key as the unit of distribution and colocation (`author_id`, `follower_id`, `handle`)
- Clustering key and `CLUSTERING ORDER BY (created_at DESC, post_id DESC)` so a partition is already a newest-first timeline
- Primary key shape `PRIMARY KEY ((partition), clustering...)` versus a single-column `PRIMARY KEY (handle)` lookup table
- Clustering tuple bound `(created_at, post_id) < cursor` for keyset paging inside one partition
- Lightweight transactions (`INSERT ... IF NOT EXISTS`) for per-partition uniqueness (user id, handle, post id)
- Dual-write compensation: a lost handle LWT deletes the `users_by_id` row; Cassandra has no cross-partition transaction
- Fan-in as N partition reads (one `posts_by_author` partition per followee) plus a merge. An inbox table would fan out on write and snapshot follows, which would break the live-feed contract.

- Distributed SQL (CockroachDB): Postgres-compatible SQL over range-partitioned keyspaces and leaseholders
- Write hotspots: monotonically increasing PKs (`SERIAL`, packed timestamps) pin inserts to the rightmost range
- Hash-sharded indexes (`USING HASH WITH (bucket_count = n)`, power-of-two buckets) prepend a hash bucket so point writes scatter
- Ordered composite keys for prefix scans: `follows (follower_id, followee_id)` and `posts (author_id, created_at, id)` stay unhashed so `following()` and `postsByAuthor()` stay one-range
- Secondary-index hotspots: a global `created_at` index is sequential even when the PK is a UUID, so that index is the one that gets hashed
- SERIALIZABLE snapshot isolation: client retry on SQLSTATE `40001` (`restart transaction`)
- Write hotspots: monotonically increasing keys (`serialKey` in this lab, packed timestamps) pin inserts to the rightmost range. The live tables use TEXT ids assigned by the caller, not SERIAL columns
- Users keep a plain primary key because `follows` and `posts` reference `users(id)`. Hash-sharding that PK would leave a unique secondary index on `id`, which is still a sequential hotspot if ids pack
- posts PK is hash-sharded, then the leftover unique on `posts(id)` from `ALTER PRIMARY KEY` is dropped so inserts do not keep appending to an unhashed unique
- Secondary-index hotspots: a global `created_at` index is sequential even when the PK is hashed, so that index is the one that gets hashed

- Labeled property graph: nodes carry labels and properties; relationships are first-class directed typed edges (`FOLLOWS`, `AUTHORED`)
- Cypher pattern matching: `MATCH (u)-[:FOLLOWS]->(a)-[:AUTHORED]->(p)` is the 2-hop feed, not a join table plus a posts scan
- Variable-length paths and `shortestPath((a)-[:FOLLOWS*..16]->(b))` (BFS with a hop cap). A recursive CTE or N+1 neighbor lookup in the other stores
- Friend-of-friend recommendation: 2-hop `FOLLOWS` expansion, exclude self and existing edges, rank by independent path count
- Common neighbors and 2-cycles (`(a)-[:FOLLOWS]->(b)-[:FOLLOWS]->(a)`) as mutual follows
- Graph uniqueness: `CREATE CONSTRAINT ... REQUIRE n.prop IS UNIQUE` (`Neo.ClientError.Schema.ConstraintValidationFailed`). `MERGE` on `FOLLOWS` is idempotent; `CREATE` on `User`/`Post` fails the unique constraint
- Query-shape taxonomy: point lookup, clustered author range, fan-in home feed, keyset continuation, and insert
- Microbenchmark methodology: `process.hrtime.bigint()`, discarded warmup, isolated write user so publishes do not pollute reads
- Latency percentiles (nearest-rank p50/p95/p99), mean, ops/s, and relative p50 per shape

- Query planner: after `ANALYZE`, `EXPLAIN` on the author timeline is an index-ordered scan of `posts_author_timeline_idx` with no Sort. The lateral feed uses that same scan per followee.
- Testcontainers: ephemeral Docker engines as test fixtures, same suite locally and in CI
- Wait strategies: `pg_isready` health check plus listening-port, rather than a fixed sleep
- Random host-port mapping so two suites can run in parallel without colliding on 5432
- Resource reaper (Ryuk): labeled containers are dropped if the test process dies
- Shared fixture plus `TRUNCATE CASCADE` isolation (amortize boot, empty catalog per case)
- MVCC unique-index locks: a second session blocks on an uncommitted handle insert, then fails with `23505` after commit
## What's implemented

- Project scaffold with TypeScript strict mode, Vitest, and CI
- Activity-feed domain, `ActivityStore` port, in-memory backend, and a shared contract suite
- Relational backend (Postgres): schema, indexes, the SQL queries for the domain
- Key-value backend (Redis): data structures + expiry, the tradeoffs vs relational

- Embedding vs referencing: `following[]` lives on the user document; posts and inbound follow edges are their own collections
- 16 MiB BSON document limit: unbounded posts are never nested under the author
- Dual-write follow: `$addToSet` / `$pull` on embedded `following[]` for the feed `$in` path; unique `{ followerId, followeeId }` edges answer `followers()`
- Unique index on `handle` (`E11000` / code 11000)
- Compound keyset via `$or` (`createdAt $lt`, or same `createdAt` and `_id $lt`); feed is `posts.find({ authorId: { $in: following } })`. Empty `$in` matches nothing.
- Document backend (MongoDB): document shape, embedding vs referencing
- Query-first data modeling (Cassandra / CQL): one table per query, denormalized writes, no joins
- Partition key as the unit of distribution and colocation (`author_id`, `follower_id`, `handle`)
- Clustering key and `CLUSTERING ORDER BY (created_at DESC, post_id DESC)` so a partition is already a newest-first timeline
- Primary key shape `PRIMARY KEY ((partition), clustering...)` versus a single-column `PRIMARY KEY (handle)` lookup table
- Clustering tuple bound `(created_at, post_id) < cursor` for keyset paging inside one partition
- Lightweight transactions (`INSERT ... IF NOT EXISTS`) for per-partition uniqueness (user id, handle, post id)
- Dual-write compensation: a lost handle LWT deletes the `users_by_id` row; Cassandra has no cross-partition transaction
- Fan-in as N partition reads (one `posts_by_author` partition per followee) plus a merge. An inbox table would fan out on write and snapshot follows, which would break the live-feed contract.
- Wide-column backend (Cassandra): query-first modeling, partition/clustering keys
- Distributed SQL (CockroachDB): Postgres-compatible SQL over range-partitioned keyspaces and leaseholders
- Write hotspots: monotonically increasing PKs (`SERIAL`, packed timestamps) pin inserts to the rightmost range
- Hash-sharded indexes (`USING HASH WITH (bucket_count = n)`, power-of-two buckets) prepend a hash bucket so point writes scatter
- Ordered composite keys for prefix scans: `follows (follower_id, followee_id)` and `posts (author_id, created_at, id)` stay unhashed so `following()` and `postsByAuthor()` stay one-range
- Secondary-index hotspots: a global `created_at` index is sequential even when the PK is a UUID, so that index is the one that gets hashed
- SERIALIZABLE snapshot isolation: client retry on SQLSTATE `40001` (`restart transaction`)
- Distributed SQL backend (CockroachDB): same SQL, hash-sharded point keys, ordered prefix scans, SERIALIZABLE retry
- Write hotspots: monotonically increasing keys (`serialKey` in this lab, packed timestamps) pin inserts to the rightmost range. The live tables use TEXT ids assigned by the caller, not SERIAL columns
- Users keep a plain primary key because `follows` and `posts` reference `users(id)`. Hash-sharding that PK would leave a unique secondary index on `id`, which is still a sequential hotspot if ids pack
- posts PK is hash-sharded, then the leftover unique on `posts(id)` from `ALTER PRIMARY KEY` is dropped so inserts do not keep appending to an unhashed unique
- Secondary-index hotspots: a global `created_at` index is sequential even when the PK is hashed, so that index is the one that gets hashed
- Distributed SQL backend (CockroachDB): same SQL, hash-sharded posts PK, ordered prefix scans, SERIALIZABLE retry
- Labeled property graph: nodes carry labels and properties; relationships are first-class directed typed edges (`FOLLOWS`, `AUTHORED`)
- Cypher pattern matching: `MATCH (u)-[:FOLLOWS]->(a)-[:AUTHORED]->(p)` is the 2-hop feed, not a join table plus a posts scan
- Variable-length paths and `shortestPath((a)-[:FOLLOWS*..16]->(b))` (BFS with a hop cap). A recursive CTE or N+1 neighbor lookup in the other stores
- Friend-of-friend recommendation: 2-hop `FOLLOWS` expansion, exclude self and existing edges, rank by independent path count
- Common neighbors and 2-cycles (`(a)-[:FOLLOWS]->(b)-[:FOLLOWS]->(a)`) as mutual follows
- Graph uniqueness: `CREATE CONSTRAINT ... REQUIRE n.prop IS UNIQUE` (`Neo.ClientError.Schema.ConstraintValidationFailed`). `MERGE` on `FOLLOWS` is idempotent; `CREATE` on `User`/`Post` fails the unique constraint
- Graph backend (Neo4j): model the relationships, Cypher queries the others struggle with
- Graph backend (Neo4j-style `MemoryGraph`): model the relationships, plus the Cypher catalog for the walks the others struggle with
- Query-shape taxonomy: point lookup, clustered author range, fan-in home feed, keyset continuation, and insert
- Microbenchmark methodology: `process.hrtime.bigint()`, discarded warmup, isolated write user so publishes do not pollute reads
- Latency percentiles (nearest-rank p50/p95/p99), mean, ops/s, and relative p50 per shape
- Benchmark the domain across backends (read/write/query shapes) into a comparison table
- Query planner: after `ANALYZE`, `EXPLAIN` on the author timeline is an index-ordered scan of `posts_author_timeline_idx` with no Sort. The lateral feed uses that same scan per followee.
- Testcontainers: ephemeral Docker engines as test fixtures, same suite locally and in CI
- Wait strategies: `pg_isready` health check plus listening-port, rather than a fixed sleep
- Random host-port mapping so two suites can run in parallel without colliding on 5432
- Resource reaper (Ryuk): labeled containers are dropped if the test process dies
- Shared fixture plus `TRUNCATE CASCADE` isolation (amortize boot, empty catalog per case)
- MVCC unique-index locks: a second session blocks on an uncommitted handle insert, then fails with `23505` after commit
- Testcontainers so each backend runs its suite in CI against a real instance
## Usage

```ts
import { MemoryRedis, MemoryStore, RedisStore } from 'polyglot-persistence'

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

const redis = RedisStore.attach(new MemoryRedis())
await redis.createUser({ id: 'ada', handle: 'ada' })
await redis.publish({ id: 'p1', authorId: 'ada', body: 'ttl demo' }, Date.now())
await redis.expirePost('p1', 60_000)
```

`PostgresStore` takes any `{ query(sql, params) }` client. Tests drive it with PGlite (`@electric-sql/pglite` is a devDependency, not a runtime dep). A server `pg` Pool works the same way.

`RedisStore` takes any `RedisCommands` client (GET/SET NX, HASH, SET, ZSET, PEXPIRE). `MemoryRedis` is an in-process engine with the same types and per-key TTL, so the contract runs without a daemon. Point the same store at a real Redis by implementing that command surface.

A new backend implements `ActivityStore` and calls `defineStoreContract(name, factory)` from `test/contract.ts`.

## Running the tests

```sh
pnpm install
pnpm test
```

Type-check with `pnpm run typecheck`.

## License

MIT
