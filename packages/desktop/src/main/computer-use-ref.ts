export function browserSnapshotRefSelector(ref: string) {
  const normalized = ref.trim()
  if (!/^(?:[1-9]|[1-9]\d|1\d\d|200)$/.test(normalized)) {
    throw new Error("Browser snapshot ref must be between 1 and 200")
  }
  return `[data-deveagent-ref="${normalized}"]`
}
