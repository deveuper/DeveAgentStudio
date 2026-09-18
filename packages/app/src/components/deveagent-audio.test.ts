import { describe, expect, test } from "bun:test"
import { encodePcm16Wav, resampleAudio } from "./deveagent-audio"

describe("DeveAgent audio conversion", () => {
  test("writes a mono PCM WAV header", () => {
    const wav = encodePcm16Wav(new Float32Array([0, 1, -1]), 16_000)
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF")
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE")
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16_000)
    expect(new DataView(wav.buffer).getUint16(22, true)).toBe(1)
    expect(wav.byteLength).toBe(50)
  })

  test("resamples without changing duration materially", () => {
    const input = new Float32Array(48_000)
    input[24_000] = 1
    const output = resampleAudio(input, 48_000, 16_000)
    expect(output.length).toBe(16_000)
    expect(output[8_000]).toBe(1)
  })
})
