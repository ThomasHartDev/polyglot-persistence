# polyglot-persistence

One domain, many stores: the same activity feed modeled on relational, document, key-value, wide-column, distributed SQL, and graph databases, with the tradeoffs written down.

## What this demonstrates

Polyglot persistence is the idea that one product rarely has one ideal database. A follow graph wants adjacency lookups, a home timeline wants a clustered time key, a session wants a TTL map, and a unique handle wants a relational constraint. This repo keeps a single domain and a single `ActivityStore` port, then implements that port on each paradigm so the query shape, consistency, and scaling tradeoffs stay comparable.

## Concepts demonstrated

- Polyglot persistence (one domain, several physical models)
- Repository / ports-and-adapters: a store interface every backend implements
- Shared contract tests that pin behavior independent of the engine
- Fan-in on read versus fan-out on write for an activity timeline
- Compound cursor pagination over a total order
- Unique constraints (user id, handle) as an application-level invariant

## What's implemented

- Project scaffold with TypeScript strict mode, Vitest, and CI

## Usage

```ts
import { VERSION } from 'polyglot-persistence'

console.log(VERSION)
```

## Running the tests

```sh
pnpm install
pnpm test
```

Type-check with `pnpm run typecheck`.

## License

MIT
