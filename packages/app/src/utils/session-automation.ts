import type { ServerSDK } from "@/context/server-sdk"

/**
 * Best-effort cancellation of a session's autonomous work (goal/loop) before
 * the session is deleted. Deleting a session with an in-progress goal would
 * otherwise leave the goal worker retrying a dead session (the plugin's goal
 * retry cap is the backstop; this app-side cancel is the primary cleanup).
 * Cancellation never blocks or fails the deletion, but a failed request is
 * logged — allSettled alone would swallow a 4xx/5xx silently.
 */
export async function cancelSessionAutomation(serverSDK: ServerSDK, sessionID: string) {
  const base = serverSDK.url.replace(/\/+$/, "")
  const headers = { "content-type": "application/json" }
  const results = await Promise.allSettled([
    serverSDK.fetch(`${base}/api/deveagent/goal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clear: true, sessionID }),
    }),
    serverSDK.fetch(`${base}/api/deveagent/loop`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "cancel", sessionID }),
    }),
  ])
  for (const result of results) {
    if (result.status === "fulfilled" && !result.value.ok) {
      console.warn(`[deveagent] cancel automation for ${sessionID} returned ${result.value.status}`)
    }
  }
}
