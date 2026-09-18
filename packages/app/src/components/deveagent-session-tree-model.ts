// Session tree model (R157): pure helpers to build a navigable tree from the
// flat session list. parentID edges come from OpenCode (TaskTool children and
// forks); the tree is rebuilt on every poll, so it always matches the store.

export type SessionTreeEntry = {
  id: string
  parentID?: string
  title?: string
}

export type SessionTreeNode = {
  id: string
  parentID?: string
  title?: string
  depth: number
  isCurrent: boolean
}

/**
 * Resolve the lineage root for `current` by walking parentID links upward
 * (cycle-guarded). Then render the whole tree depth-first from that root so
 * every sibling branch is visible next to the main lineage. Sessions outside
 * the tree stay out.
 */
export function buildSessionLineage(
  sessions: SessionTreeEntry[],
  currentID: string,
): SessionTreeNode[] {
  const byID = new Map<string, SessionTreeEntry>()
  for (const session of sessions) byID.set(session.id, session)
  if (!byID.has(currentID)) return []

  const childrenOf = new Map<string, SessionTreeEntry[]>()
  const roots: SessionTreeEntry[] = []
  for (const session of sessions) {
    const parent = session.parentID && byID.has(session.parentID) ? byID.get(session.parentID) : undefined
    if (parent) {
      if (!childrenOf.has(parent.id)) childrenOf.set(parent.id, [])
      childrenOf.get(parent.id)!.push(session)
    } else {
      roots.push(session)
    }
  }

  // The current session's lineage root: walk up from current, then take that
  // chain's topmost node. Every other session in the list is excluded (it is
  // not part of this lineage).
  const ancestors: SessionTreeEntry[] = []
  let cursor: string | undefined = currentID
  for (let guard = 0; guard < 64 && cursor; guard++) {
    const entry = byID.get(cursor)
    if (!entry) break
    ancestors.unshift(entry)
    cursor = entry.parentID
    if (!cursor) break
    const parentEntry = byID.get(cursor)
    if (!parentEntry) break
  }
  const root = ancestors[0]
  if (!root) return []

  const out: SessionTreeNode[] = []
  const seen = new Set<string>()
  const walk = (entry: SessionTreeEntry, depth: number) => {
    if (seen.has(entry.id)) return
    seen.add(entry.id)
    out.push({ id: entry.id, parentID: entry.parentID, title: entry.title, depth, isCurrent: entry.id === currentID })
    for (const child of childrenOf.get(entry.id) ?? []) walk(child, depth + 1)
  }
  walk(root, 0)
  return out
}
