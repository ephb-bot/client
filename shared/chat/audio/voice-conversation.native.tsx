import * as React from 'react'
import {Audio} from 'expo-av'
import {setupAudioMode} from '@/util/audio.native'
import {startHeartbeat, stopHeartbeat} from '@/util/silent-heartbeat.native'
import {startPushToTalk, stopPushToTalk, updateNowPlaying, type RemoteCommandEvent} from 'react-native-kb'
import {AmpTracker} from '@/chat/audio/amptracker'
import logger from '@/logger'
import {File as FSFile} from 'expo-file-system'

// Voice conversation state machine for hands-free audio chat.
//
// Flow: IDLE -> LISTENING -> RECORDING -> WAITING_FOR_RESPONSE -> PLAYING -> LISTENING (loop)
//
// - IDLE: no voice session active
// - LISTENING: waiting for PTT trigger (heartbeat running to keep Now Playing alive)
// - RECORDING: user is speaking, audio is being captured
// - WAITING_FOR_RESPONSE: recording sent, waiting for bot reply
// - PLAYING: bot audio response is playing (managed externally by autoplay queue)

export type VoiceState = 'idle' | 'listening' | 'recording' | 'waitingForResponse' | 'playing'

export type VoiceSessionCallbacks = {
  // Called when recording finishes - consumer sends the audio and returns a promise
  onRecordingComplete: (path: string, durationMs: number, amps: ReadonlyArray<number>) => void
  // Called when the voice session starts/stops
  onSessionStateChange?: (state: VoiceState) => void
}

const RECORDING_OPTIONS = {
  android: {
    audioEncoder: Audio.AndroidAudioEncoder.AAC,
    bitRate: 32000,
    extension: '.m4a',
    numberOfChannels: 1,
    outputFormat: Audio.AndroidOutputFormat.MPEG_4,
    sampleRate: 22050,
  },
  ios: {
    audioQuality: Audio.IOSAudioQuality.MIN,
    bitRate: 32000,
    extension: '.m4a',
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
    numberOfChannels: 1,
    outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
    sampleRate: 22050,
  },
  isMeteringEnabled: true,
  web: {},
} as const

const NOW_PLAYING_TITLES: Record<VoiceState, string> = {
  idle: 'Keybase Voice',
  listening: 'Listening...',
  recording: 'Recording...',
  waitingForResponse: 'Thinking...',
  playing: 'Playing response',
}

export const useVoiceConversation = (callbacks: VoiceSessionCallbacks) => {
  const {onRecordingComplete, onSessionStateChange} = callbacks
  const [state, setState] = React.useState<VoiceState>('idle')
  const stateRef = React.useRef<VoiceState>('idle')
  const recordingRef = React.useRef<Audio.Recording | undefined>(undefined)
  const recordStartRef = React.useRef(0)
  const ampTracker = React.useRef(new AmpTracker()).current
  const cleanupPTTRef = React.useRef<(() => void) | undefined>(undefined)

  const setVoiceState = React.useCallback(
    (newState: VoiceState) => {
      stateRef.current = newState
      setState(newState)
      onSessionStateChange?.(newState)

      // Update Now Playing info based on state
      const title = NOW_PLAYING_TITLES[newState]
      const rate = newState === 'playing' ? 1.0 : 0.0
      updateNowPlaying(title, 'Keybase', rate, 0)
    },
    [onSessionStateChange]
  )

  // Start recording audio
  const beginRecording = React.useCallback(async () => {
    try {
      // Stop heartbeat while recording - we need the audio session for recording
      await stopHeartbeat()
      await setupAudioMode(true)

      const recording = new Audio.Recording()
      await recording.prepareToRecordAsync(RECORDING_OPTIONS)
      recording.setProgressUpdateInterval(100)
      recording.setOnRecordingStatusUpdate(status => {
        const inamp = status.metering
        if (inamp !== undefined) {
          const amp = 10 ** (inamp * 0.05)
          ampTracker.addAmp(amp)
        }
      })

      recordingRef.current = recording
      recordStartRef.current = Date.now()
      await recording.startAsync()
      setVoiceState('recording')
    } catch (e) {
      logger.warn('Voice conversation: failed to start recording: ' + String(e))
      // Fall back to listening state
      await setupAudioMode(false)
      await startHeartbeat()
      setVoiceState('listening')
    }
  }, [ampTracker, setVoiceState])

  // Stop recording and send the audio
  const finishRecording = React.useCallback(async () => {
    const recording = recordingRef.current
    recordingRef.current = undefined

    if (!recording) {
      setVoiceState('listening')
      return
    }

    try {
      recording.setOnRecordingStatusUpdate(null)
      await recording.stopAndUnloadAsync()
      await setupAudioMode(false)
    } catch (e) {
      logger.warn('Voice conversation: error stopping recording: ' + String(e))
    }

    const durationMs = Date.now() - recordStartRef.current
    const path = recording.getURI()?.replace('file://', '') ?? ''
    const amps = ampTracker.getBucketedAmps(durationMs)
    ampTracker.reset()

    if (durationMs > 500 && path && amps.length) {
      setVoiceState('waitingForResponse')
      // Start heartbeat while waiting for response
      await startHeartbeat()
      onRecordingComplete(path, durationMs, amps)
    } else {
      // Too short or missing data - go back to listening
      if (path) {
        try {
          const f = new FSFile(path)
          if (f.exists) f.delete()
        } catch {}
      }
      await startHeartbeat()
      setVoiceState('listening')
    }
  }, [ampTracker, onRecordingComplete, setVoiceState])

  // Cancel recording without sending
  const cancelRecording = React.useCallback(async () => {
    const recording = recordingRef.current
    recordingRef.current = undefined

    if (recording) {
      recording.setOnRecordingStatusUpdate(null)
      try {
        await recording.stopAndUnloadAsync()
      } catch {}
      const path = recording.getURI()?.replace('file://', '') ?? ''
      if (path) {
        try {
          const f = new FSFile(path)
          if (f.exists) f.delete()
        } catch {}
      }
    }

    ampTracker.reset()
    await setupAudioMode(false)
    await startHeartbeat()
    setVoiceState('listening')
  }, [ampTracker, setVoiceState])

  // Handle remote command events from AirPods / headset
  const handleRemoteCommand = React.useCallback(
    (event: RemoteCommandEvent) => {
      const currentState = stateRef.current

      switch (event.command) {
        case 'togglePlayPause':
          // Single tap on AirPods - toggle recording
          if (currentState === 'listening') {
            beginRecording().catch(() => {})
          } else if (currentState === 'recording') {
            finishRecording().catch(() => {})
          }
          break

        case 'play':
          // Play command - start recording if listening
          if (currentState === 'listening') {
            beginRecording().catch(() => {})
          }
          break

        case 'pause':
          // Pause command - stop recording if recording
          if (currentState === 'recording') {
            finishRecording().catch(() => {})
          }
          break

        case 'nextTrack':
          // Double tap on AirPods - cancel current recording or skip
          if (currentState === 'recording') {
            cancelRecording().catch(() => {})
          }
          break

        case 'previousTrack':
          // Triple tap on AirPods - no-op for now
          break

        case 'volumeButton':
          // Volume button press - same as togglePlayPause
          if (currentState === 'listening') {
            beginRecording().catch(() => {})
          } else if (currentState === 'recording') {
            finishRecording().catch(() => {})
          }
          break
      }
    },
    [beginRecording, finishRecording, cancelRecording]
  )

  // Start a voice conversation session
  const startSession = React.useCallback(
    async (useVolumeButton: boolean = false) => {
      if (stateRef.current !== 'idle') return

      // Check microphone permissions
      let {status} = await Audio.getPermissionsAsync()
      if (status === Audio.PermissionStatus.UNDETERMINED) {
        const askRes = await Audio.requestPermissionsAsync()
        status = askRes.status
      }
      if (status === Audio.PermissionStatus.DENIED) {
        logger.warn('Voice conversation: microphone permission denied')
        return
      }

      // Start heartbeat to maintain Now Playing status
      await startHeartbeat()

      // Register for remote commands
      cleanupPTTRef.current = startPushToTalk(handleRemoteCommand, useVolumeButton)
      setVoiceState('listening')
    },
    [handleRemoteCommand, setVoiceState]
  )

  // Stop the voice conversation session entirely
  const stopSession = React.useCallback(async () => {
    // Cancel any in-progress recording
    if (stateRef.current === 'recording') {
      await cancelRecording()
    }

    // Stop heartbeat
    await stopHeartbeat()

    // Unregister remote commands
    if (cleanupPTTRef.current) {
      cleanupPTTRef.current()
      cleanupPTTRef.current = undefined
    }
    stopPushToTalk()

    setVoiceState('idle')
  }, [cancelRecording, setVoiceState])

  // Notify the state machine that bot audio playback has started
  const notifyPlaybackStarted = React.useCallback(async () => {
    if (stateRef.current === 'waitingForResponse' || stateRef.current === 'listening') {
      await stopHeartbeat()
      setVoiceState('playing')
    }
  }, [setVoiceState])

  // Notify the state machine that bot audio playback has finished
  const notifyPlaybackFinished = React.useCallback(async () => {
    if (stateRef.current === 'playing') {
      await startHeartbeat()
      setVoiceState('listening')
    }
  }, [setVoiceState])

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (stateRef.current !== 'idle') {
        stopHeartbeat().catch(() => {})
        stopPushToTalk()
        if (recordingRef.current) {
          recordingRef.current.setOnRecordingStatusUpdate(null)
          recordingRef.current.stopAndUnloadAsync().catch(() => {})
        }
      }
    }
  }, [])

  return {
    state,
    startSession,
    stopSession,
    notifyPlaybackStarted,
    notifyPlaybackFinished,
    // Expose for manual triggering from UI buttons
    beginRecording,
    finishRecording,
    cancelRecording,
  }
}
