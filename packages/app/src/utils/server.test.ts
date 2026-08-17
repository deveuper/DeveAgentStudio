import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, createFetchForServer } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to opencode", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "opencode", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("opencode:secret"))
  })
})

test("createFetchForServer authenticates custom API requests", async () => {
  let authorization: string | null = null
  const request = createFetchForServer(
    { url: "http://localhost:4096", username: "kit", password: "secret" },
    async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization")
      return new Response(null, { status: 204 })
    },
  )

  await request("http://localhost:4096/api/deveagent/codegraph/context-pack")
  expect(String(authorization)).toBe(`Basic ${btoa("kit:secret")}`)
})
