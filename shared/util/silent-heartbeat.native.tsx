import {Audio} from 'expo-av'
import {File, Paths} from 'expo-file-system'
import {setupAudioMode} from './audio.native'

// Silent audio heartbeat - plays an inaudible audio loop to maintain
// Now Playing status on iOS so MPRemoteCommandCenter stays responsive
// (e.g., AirPods tap controls remain active between bot responses).

let heartbeatSound: Audio.Sound | undefined
let heartbeatPlaying = false
let silentFileUri: string | undefined

// Generate a minimal silent WAV file (0.1s, 8kHz, mono, 16-bit PCM)
const ensureSilentFile = async (): Promise<string> => {
  if (silentFileUri) {
    const file = new File(silentFileUri)
    if (file.exists) return silentFileUri
  }

  const sampleRate = 8000
  const numSamples = 800 // 0.1 seconds
  const bytesPerSample = 2
  const dataSize = numSamples * bytesPerSample
  const headerSize = 44
  const fileSize = headerSize + dataSize

  const bytes = new Uint8Array(fileSize)
  const dv = new DataView(bytes.buffer)

  // RIFF header
  bytes.set([0x52, 0x49, 0x46, 0x46], 0)
  dv.setUint32(4, fileSize - 8, true)
  bytes.set([0x57, 0x41, 0x56, 0x45], 8)

  // fmt sub-chunk
  bytes.set([0x66, 0x6d, 0x74, 0x20], 12)
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * bytesPerSample, true)
  dv.setUint16(32, bytesPerSample, true)
  dv.setUint16(34, 16, true)

  // data sub-chunk (all zeros = silence for 16-bit PCM)
  bytes.set([0x64, 0x61, 0x74, 0x61], 36)
  dv.setUint32(40, dataSize, true)

  const file = new File(Paths.cache, 'keybase-silent-heartbeat.wav')
  file.write(bytes)
  silentFileUri = file.uri
  return silentFileUri
}

export const startHeartbeat = async (): Promise<void> => {
  if (heartbeatPlaying) return

  try {
    await setupAudioMode(false)
    const path = await ensureSilentFile()

    const {sound} = await Audio.Sound.createAsync(
      {uri: path},
      {
        isLooping: true,
        isMuted: false,
        shouldPlay: true,
        volume: 0.01, // near-silent but nonzero so audio session stays active
      }
    )
    heartbeatSound = sound
    heartbeatPlaying = true
  } catch (e) {
    console.warn('Failed to start silent heartbeat:', e)
    heartbeatPlaying = false
  }
}

export const stopHeartbeat = async (): Promise<void> => {
  if (!heartbeatPlaying || !heartbeatSound) {
    heartbeatPlaying = false
    return
  }

  try {
    await heartbeatSound.stopAsync()
    await heartbeatSound.unloadAsync()
  } catch {
    // ignore cleanup errors
  }
  heartbeatSound = undefined
  heartbeatPlaying = false
}

export const isHeartbeatPlaying = (): boolean => heartbeatPlaying
