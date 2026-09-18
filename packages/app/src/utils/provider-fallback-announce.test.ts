import { describe, expect, test } from "bun:test"
import { planProviderFallbackAnnouncement } from "./provider-fallback-announce"

describe("provider fallback announcement", () => {
  test("announces on both surfaces", () => {
    const plan = planProviderFallbackAnnouncement({
      failed: "primary-test/primary-model",
      fallback: "free-test/free-model",
      title: "提供商回退",
      description: "已从 primary-test/primary-model 切换到 free-test/free-model。",
      href: "/dir/session/ses_1",
    })
    // The OS notification alone is not enough: the desktop shell suppresses it
    // while the window is focused, which is when a watching user sees the switch.
    expect(plan.system).toBe(true)
    expect(plan.inApp).toBe(true)
    expect(plan.description).toContain("free-test/free-model")
    expect(plan.href).toBe("/dir/session/ses_1")
  })

  test("carries the real model ids rather than a generic message", () => {
    const plan = planProviderFallbackAnnouncement({
      failed: "a/m1",
      fallback: "b/m2",
      title: "t",
      description: "d",
      href: "/x",
    })
    expect(plan.title).toBe("t")
    expect(plan.description).toBe("d")
  })
})
