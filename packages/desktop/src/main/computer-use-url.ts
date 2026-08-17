import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export function isPrivateComputerUseAddress(address: string) {
  const normalized = address.toLowerCase()
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  ) {
    return true
  }
  const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16)
    const low = Number.parseInt(mapped[2], 16)
    return isPrivateComputerUseAddress([high >> 8, high & 255, low >> 8, low & 255].join("."))
  }
  if (normalized.startsWith("::ffff:")) return isPrivateComputerUseAddress(normalized.slice(7))

  const parts = normalized.split(".").map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] >= 224
  )
}

export function parsePublicComputerUseUrl(raw: string) {
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Browser URL must use http or https")
  if (url.username || url.password) throw new Error("Browser URL must not include credentials")
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!host || host === "localhost" || host.endsWith(".localhost") || (isIP(host) && isPrivateComputerUseAddress(host))) {
    throw new Error("Browser URL must not target private or local addresses")
  }
  return url
}

const isDocumentLocalComputerUseUrl = (url: URL) =>
  url.protocol === "data:" ||
  url.protocol === "blob:" ||
  url.href === "about:blank" ||
  url.href === "about:srcdoc"

export function parseComputerUseNavigationUrl(raw: string) {
  const url = new URL(raw)
  if (isDocumentLocalComputerUseUrl(url)) return url
  return parsePublicComputerUseUrl(raw)
}

export async function assertComputerUseNavigationUrl(raw: string) {
  const url = parseComputerUseNavigationUrl(raw)
  if (!COMPUTER_USE_NETWORK_PROTOCOLS.has(url.protocol) || isIP(url.hostname)) return url
  const addresses = await lookup(url.hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((item) => isPrivateComputerUseAddress(item.address))) {
    throw new Error("Browser URL must not resolve to private or local addresses")
  }
  return url
}

const COMPUTER_USE_NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"])

/**
 * Validate every URL requested by the hidden browser, including subresources.
 * about/data/blob URLs are local to the already-approved document; network
 * protocols still require a public host and are resolved before the request is
 * released by the Electron webRequest gate.
 */
export function parsePublicComputerUseRequestUrl(raw: string) {
  const url = new URL(raw)
  if (url.protocol === "about:") {
    if (url.href !== "about:blank" && url.href !== "about:srcdoc") throw new Error("Browser request uses a disallowed about URL")
    return url
  }
  if (url.protocol === "data:" || url.protocol === "blob:") return url
  if (!COMPUTER_USE_NETWORK_PROTOCOLS.has(url.protocol)) throw new Error("Browser request uses a disallowed protocol")
  if (url.username || url.password) throw new Error("Browser request must not include credentials")
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!host || host === "localhost" || host.endsWith(".localhost") || (isIP(host) && isPrivateComputerUseAddress(host))) {
    throw new Error("Browser request must not target private or local addresses")
  }
  return url
}

export async function assertPublicComputerUseRequestUrl(raw: string) {
  const url = parsePublicComputerUseRequestUrl(raw)
  if (!COMPUTER_USE_NETWORK_PROTOCOLS.has(url.protocol) || isIP(url.hostname)) return url
  const addresses = await lookup(url.hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((item) => isPrivateComputerUseAddress(item.address))) {
    throw new Error("Browser request must not resolve to private or local addresses")
  }
  return url
}

export async function assertPublicComputerUseUrl(raw: string) {
  const url = parsePublicComputerUseUrl(raw)
  const addresses = await lookup(url.hostname, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some((item) => isPrivateComputerUseAddress(item.address))) {
    throw new Error("Browser URL must not resolve to private or local addresses")
  }
  return url
}
