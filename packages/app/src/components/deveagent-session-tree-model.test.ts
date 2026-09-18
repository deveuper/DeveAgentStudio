import { describe, expect, test } from "bun:test"
import { buildSessionLineage, type SessionTreeEntry } from "./deveagent-session-tree-model"

const sessions: SessionTreeEntry[] = [
  { id: "root", title: "Root session" },
  { id: "mid", parentID: "root", title: "Forked mid" },
  { id: "leaf", parentID: "mid", title: "Leaf" },
  { id: "sibling", parentID: "root", title: "Sibling branch" },
  { id: "unrelated", title: "Unrelated session" },
]

describe("buildSessionLineage", () => {
  test("orders ancestors root→current then descendants depth-first", () => {
    const lineage = buildSessionLineage(sessions, "leaf")
    expect(lineage.map((node) => node.id)).toEqual(["root", "mid", "leaf", "sibling"])
    expect(lineage.find((node) => node.id === "root")?.depth).toBe(0)
    expect(lineage.find((node) => node.id === "mid")?.depth).toBe(1)
    expect(lineage.find((node) => node.id === "leaf")?.depth).toBe(2)
    expect(lineage.find((node) => node.id === "sibling")?.depth).toBe(1)
  })

  test("marks the current session", () => {
    const lineage = buildSessionLineage(sessions, "mid")
    expect(lineage.find((node) => node.id === "mid")?.isCurrent).toBe(true)
    expect(lineage.filter((node) => node.isCurrent)).toHaveLength(1)
  })

  test("excludes unrelated sessions", () => {
    const lineage = buildSessionLineage(sessions, "root")
    expect(lineage.some((node) => node.id === "unrelated")).toBe(false)
  })

  test("survives a parent cycle without hanging", () => {
    const cyclic: SessionTreeEntry[] = [
      { id: "a", parentID: "b", title: "A" },
      { id: "b", parentID: "a", title: "B" },
    ]
    const lineage = buildSessionLineage(cyclic, "a")
    expect(lineage.length).toBeGreaterThan(0)
  })

  test("a missing ancestor still renders the current lineage", () => {
    const lineage = buildSessionLineage([{ id: "orphan", parentID: "gone-parent" }], "orphan")
    expect(lineage.map((node) => node.id)).toEqual(["orphan"])
  })
})
