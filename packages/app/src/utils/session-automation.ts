import type { ServerSDK } from "@/context/server-sdk"

/**
 * Best-effort cancellation of a session's autonomous work (goal/loop) before
 * the session is deleted. Deleting a session with an in-progress goal would
 * otherwise leave the goal worker retrying a dead session (goals have no retry
 * budget; this app-side cancel is the primary cleanup and the plugin's goal
 * retry cap is defense-in-depth). The cancellation never blocks or fails the
 * deletion: failures are swallowed by Promise.allSettled.
 */
export async function cancelSessionAutomation(serverSDK: ServerSDK, sessionID: string) {
  const base = serverSDK.url.replace(/\/+$/, "")
  const headers = { "content-type": "application/json" }
  await Promise.allSettled([
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
}
