import { describe, expect, test } from "bun:test"
import { assertComputerUseNavigationUrl, isPrivateComputerUseAddress, parseComputerUseNavigationUrl, parsePublicComputerUseRequestUrl, parsePublicComputerUseUrl } from "./computer-use-url"

describe("computer use browser URL boundary", () => {
  test("rejects local, private, credentialed, and unsupported targets before navigation", () => {
    for (const value of [
      "http://localhost:3000",
      "https://sub.localhost/",
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://[::1]/",
      "https://user:secret@example.com/",
      "file:///C:/secret.txt",
    ]) {
      expect(() => parsePublicComputerUseUrl(value)).toThrow()
    }
  })

  test("keeps public HTTP targets and blocks reserved address ranges", () => {
    expect(parsePublicComputerUseUrl("https://example.com/path").hostname).toBe("example.com")
    expect(isPrivateComputerUseAddress("100.64.0.1")).toBe(true)
    expect(isPrivateComputerUseAddress("224.0.0.1")).toBe(true)
    expect(isPrivateComputerUseAddress("::ffff:7f00:1")).toBe(true)
    expect(isPrivateComputerUseAddress("::ffff:c0a8:0101")).toBe(true)
    expect(isPrivateComputerUseAddress("::ffff:0808:0808")).toBe(false)
    expect(isPrivateComputerUseAddress("8.8.8.8")).toBe(false)
  })

  test("request boundary allows document-local URLs and rejects non-browser protocols", () => {
    expect(parsePublicComputerUseRequestUrl("about:blank").protocol).toBe("about:")
    expect(parsePublicComputerUseRequestUrl("data:text/plain,ok").protocol).toBe("data:")
    expect(parsePublicComputerUseRequestUrl("blob:https://example.com/id").protocol).toBe("blob:")
    expect(parsePublicComputerUseRequestUrl("wss://example.com/socket").protocol).toBe("wss:")
    for (const value of ["file:///C:/Windows/win.ini", "ftp://example.com/file", "http://127.0.0.1/image.png"]) {
      expect(() => parsePublicComputerUseRequestUrl(value)).toThrow()
    }
  })

  test("navigation boundary allows document-local fixtures without widening public URL validation", async () => {
    for (const value of ["about:blank", "about:srcdoc", "data:text/html,<p>fixture</p>", "blob:https://example.com/id"]) {
      expect(parseComputerUseNavigationUrl(value).protocol).toBe(new URL(value).protocol)
      await expect(assertComputerUseNavigationUrl(value)).resolves.toBeInstanceOf(URL)
    }
    expect(() => parsePublicComputerUseUrl("data:text/html,<p>fixture</p>")).toThrow()
  })
})
