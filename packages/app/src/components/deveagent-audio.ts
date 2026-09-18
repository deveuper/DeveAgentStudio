function monoSamples(buffer: AudioBuffer) {
  const output = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const input = buffer.getChannelData(channel)
    for (let i = 0; i < output.length; i++) output[i] += (input[i] ?? 0) / buffer.numberOfChannels
  }
  return output
}

export function resampleAudio(input: Float32Array, sourceRate: number, targetRate = 16_000) {
  if (!input.length || sourceRate === targetRate) return input.slice()
  const length = Math.max(1, Math.round(input.length * targetRate / sourceRate))
  const output = new Float32Array(length)
  const scale = sourceRate / targetRate
  for (let i = 0; i < length; i++) {
    const position = i * scale
    const left = Math.min(input.length - 1, Math.floor(position))
    const right = Math.min(input.length - 1, left + 1)
    const mix = position - left
    output[i] = (input[left] ?? 0) * (1 - mix) + (input[right] ?? 0) * mix
  }
  return output
}

export function encodePcm16Wav(samples: Float32Array, sampleRate = 16_000) {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  ascii(0, "RIFF")
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, "data")
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return bytes
}

export async function recordingToWav(blob: Blob) {
  const context = new AudioContext()
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer())
    const samples = resampleAudio(monoSamples(decoded), decoded.sampleRate)
    return new Blob([encodePcm16Wav(samples) as unknown as BlobPart], { type: "audio/wav" })
  } finally {
    await context.close()
  }
}
