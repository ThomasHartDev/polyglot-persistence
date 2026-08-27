export class ConstraintError extends Error {
  readonly code = 'Neo.ClientError.Schema.ConstraintValidationFailed'
  constructor(readonly constraint: string) {
    super(constraint)
    this.name = 'Neo4jError'
  }
}

export type Props = Record<string, unknown>

interface Node {
  labels: string[]
  props: Props
}

function specOf(name: string): { label: string; prop: string } {
  if (name === 'user_handle') return { label: 'User', prop: 'handle' }
  if (name === 'post_id') return { label: 'Post', prop: 'id' }
  return { label: 'User', prop: 'id' }
}

export class MemoryGraph {
  private readonly nodes = new Map<string, Node>()
  private readonly out = new Map<string, { type: string; to: string }[]>()
  private readonly unique = new Map<string, Map<string, string>>()
  private seq = 0

  constrain(cypher: string): void {
    const name = cypher.split(' ')[2]
    if (name && !this.unique.has(name)) this.unique.set(name, new Map())
  }

  nodesWithLabel(label: string): Node[] {
    return [...this.nodes.values()].filter((n) => n.labels.includes(label))
  }

  rels(type: string): { type: string; fromId: unknown; toId: unknown }[] {
    const rows: { type: string; fromId: unknown; toId: unknown }[] = []
    for (const [from, list] of this.out) {
      for (const rel of list) {
        if (rel.type === type) {
          rows.push({
            type,
            fromId: this.nodes.get(from)?.props.id,
            toId: this.nodes.get(rel.to)?.props.id,
          })
        }
      }
    }
    return rows
  }

  createNode(labels: string[], props: Props): string {
    for (const [name, seen] of this.unique) {
      const spec = specOf(name)
      if (!labels.includes(spec.label) || props[spec.prop] === undefined) continue
      if (seen.has(String(props[spec.prop]))) throw new ConstraintError(name)
    }
    const id = `n${this.seq++}`
    this.nodes.set(id, { labels, props: { ...props } })
    this.out.set(id, [])
    for (const [name, seen] of this.unique) {
      const spec = specOf(name)
      if (labels.includes(spec.label) && props[spec.prop] !== undefined) {
        seen.set(String(props[spec.prop]), id)
      }
    }
    return id
  }

  find(label: string, prop: string, value: unknown): string | undefined {
    for (const [id, node] of this.nodes) {
      if (node.labels.includes(label) && node.props[prop] === value) return id
    }
    return undefined
  }

  props(id: string | undefined): Props | undefined {
    return id === undefined ? undefined : this.nodes.get(id)?.props
  }

  mergeRel(from: string, type: string, to: string): void {
    const list = this.out.get(from)
    if (!list || list.some((r) => r.type === type && r.to === to)) return
    list.push({ type, to })
  }

  deleteRel(from: string, type: string, to: string): void {
    const list = this.out.get(from)
    if (list) this.out.set(from, list.filter((r) => !(r.type === type && r.to === to)))
  }

  neighbors(from: string, type: string): string[] {
    return (this.out.get(from) ?? []).filter((r) => r.type === type).map((r) => r.to)
  }

  inbound(to: string, type: string): string[] {
    const ids: string[] = []
    for (const [from, list] of this.out) {
      if (list.some((r) => r.type === type && r.to === to)) ids.push(from)
    }
    return ids
  }

  bfs(start: string, goal: string, type: string, maxHops: number): string[] | null {
    if (start === goal) return null
    const parent = new Map<string, string>()
    const dist = new Map([[start, 0]])
    const queue = [start]
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]
      if (cur === undefined) break
      const d = dist.get(cur) ?? 0
      if (d >= maxHops) continue
      for (const next of this.neighbors(cur, type)) {
        if (dist.has(next)) continue
        dist.set(next, d + 1)
        parent.set(next, cur)
        if (next === goal) {
          const ids: string[] = []
          let at: string | undefined = goal
          while (at) {
            ids.push(String(this.nodes.get(at)?.props.id ?? ''))
            if (at === start) break
            at = parent.get(at)
          }
          return ids.reverse()
        }
        queue.push(next)
      }
    }
    return null
  }
}
