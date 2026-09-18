import { describe, expect, test } from "bun:test"

import { deveAgentSidebarSectionId } from "./deveagent-layout-sidebar"

describe("DeveAgent layout sidebar", () => {
  test("keeps collapse toggles linked to their visible groups", () => {
    expect(deveAgentSidebarSectionId("workspace")).toBe("deveagent-sidebar-workspace-group")
    expect(deveAgentSidebarSectionId("capabilities")).toBe("deveagent-sidebar-capabilities-group")
    expect(deveAgentSidebarSectionId("workspace")).not.toBe(deveAgentSidebarSectionId("capabilities"))
  })
})
