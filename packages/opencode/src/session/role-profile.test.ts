import { expect, test } from "bun:test"
import { resolveRoleProfileModel } from "./prompt"
import { clearRoleProfile, getRoleProfile, listRoleProfiles, setRoleProfile } from "../plugin/deveagent"

// Focused suite for Role Profile model routing precedence.
//
// The pure decision (resolveRoleProfileModel) and the plugin's role-profile
// registry (setRoleProfile/getRoleProfile) are both reachable without a live
// SessionPrompt fixture. The remaining step — resolving the routed ref against
// the Provider registry inside createUserMessage — is Effect-backed and needs
// the full SessionPrompt layer, which this package's focused tests do not
// build. That end-to-end path is covered by the packaged E2E
// (tests/ui-e2e-role-profile.mjs). Assertions here target only what is real.
//
// NOTE: this suite imports setRoleProfile/getRoleProfile from ../plugin/deveagent.
// Those exports land together with the role-profile HTTP route in a parallel
// change; until then this file will not compile (bun test reports the import
// failure), which is the expected state while the two changes are landing.

const REVIEWER = { providerID: "text-test", modelID: "reviewer-model" }
const DEFAULT_MODEL = { providerID: "text-test", modelID: "text-model" }

test("an explicit role routes to the role's configured model when no model is pinned", () => {
  setRoleProfile("reviewer", REVIEWER)
  expect(resolveRoleProfileModel({ role: "reviewer", explicitModel: undefined, roleProfile: getRoleProfile("reviewer") })).toEqual(
    REVIEWER,
  )
})

test("an explicit input.model takes precedence over the role profile", () => {
  setRoleProfile("reviewer", REVIEWER)
  expect(
    resolveRoleProfileModel({ role: "reviewer", explicitModel: DEFAULT_MODEL, roleProfile: getRoleProfile("reviewer") }),
  ).toBeUndefined()
})

test("an unknown role leaves the model unchanged", () => {
  setRoleProfile("reviewer", REVIEWER)
  expect(resolveRoleProfileModel({ role: "ghost-role", explicitModel: undefined, roleProfile: getRoleProfile("ghost-role") })).toBeUndefined()
})

test("a missing or incomplete role profile leaves the model unchanged", () => {
  expect(resolveRoleProfileModel({ role: "reviewer", explicitModel: undefined, roleProfile: undefined })).toBeUndefined()
  expect(
    resolveRoleProfileModel({ role: "reviewer", explicitModel: undefined, roleProfile: { providerID: "text-test" } }),
  ).toBeUndefined()
  expect(
    resolveRoleProfileModel({ role: "reviewer", explicitModel: undefined, roleProfile: { providerID: "", modelID: "reviewer-model" } }),
  ).toBeUndefined()
})

test("the plugin role-profile registry round-trips a configured profile", () => {
  setRoleProfile("reviewer", REVIEWER)
  expect(getRoleProfile("reviewer")).toEqual(REVIEWER)
})

test("no role and no explicit model resolves to no role routing", () => {
  expect(resolveRoleProfileModel({ role: undefined, explicitModel: undefined, roleProfile: REVIEWER })).toBeUndefined()
})

test("setRoleProfile rejects new roles beyond the 16-profile registry bound", () => {
  const existing = Object.keys(listRoleProfiles())
  // Captured before any mutation: the overwrite branch persists to the real
  // store, so the pre-existing profile must be restored afterwards (review P2).
  const original = existing[0] ? getRoleProfile(existing[0]) : undefined
  const created: string[] = []
  try {
    // Fill the registry to the bound with fresh roles (earlier tests may have
    // left "reviewer" behind, so compute the remaining headroom).
    const fill = Math.max(0, 16 - existing.length)
    for (let i = 0; i < fill; i++) {
      const role = `bound-${i}`
      const result = setRoleProfile(role, { providerID: "text-test", modelID: "text-model" })
      expect(result.ok).toBe(true)
      created.push(role)
    }
    // A 17th new role must fail loudly instead of silently being dropped by
    // normalizeRoleProfiles while setRoleProfile reports success.
    const overflow = setRoleProfile("bound-overflow", { providerID: "text-test", modelID: "text-model" })
    expect(overflow.ok).toBe(false)
    expect(overflow.ok === false && overflow.error).toContain("limit")
    // Overwriting an already-bound role still succeeds at the bound.
    const target = existing[0] ?? created[0]
    const overwrite = setRoleProfile(target, { providerID: "text-test", modelID: "text-model" })
    expect(overwrite.ok).toBe(true)
  } finally {
    for (const role of created) clearRoleProfile(role)
    if (existing[0]) {
      if (original) setRoleProfile(existing[0], original)
      else clearRoleProfile(existing[0])
    }
  }
})
