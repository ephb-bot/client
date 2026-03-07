import * as React from 'react'
import * as Chat from '@/constants/chat2'
import {useVoiceConversation, type VoiceState} from './voice-conversation.native'

// VoiceSession bridges the useVoiceConversation hook with the convo store.
// It is a renderless component - it manages lifecycle only.
// When voiceSessionActive becomes true in the store, it starts the PTT session.
// When the user records and sends, it calls sendAudioRecording from the store.

const VoiceSession = React.memo(function VoiceSession() {
  const voiceSessionActive = Chat.useChatContext(s => s.voiceSessionActive)
  const sendAudioRecording = Chat.useChatContext(s => s.dispatch.sendAudioRecording)
  const autoplayPlaying = Chat.useChatContext(s => s.autoplayPlaying)

  const onRecordingComplete = React.useCallback(
    (path: string, durationMs: number, amps: ReadonlyArray<number>) => {
      sendAudioRecording(path, durationMs, amps).catch(() => {})
    },
    [sendAudioRecording]
  )

  const onSessionStateChange = React.useCallback((_state: VoiceState) => {
    // Could be used for UI indicators in the future
  }, [])

  const voice = useVoiceConversation({
    onRecordingComplete,
    onSessionStateChange,
  })

  // Start/stop session based on store state
  const prevActiveRef = React.useRef(false)
  React.useEffect(() => {
    if (voiceSessionActive && !prevActiveRef.current) {
      voice.startSession().catch(() => {})
    } else if (!voiceSessionActive && prevActiveRef.current) {
      voice.stopSession().catch(() => {})
    }
    prevActiveRef.current = voiceSessionActive
  }, [voiceSessionActive, voice.startSession, voice.stopSession])

  // Notify voice state machine when autoplay starts/finishes
  const prevAutoplayRef = React.useRef<typeof autoplayPlaying>(undefined)
  React.useEffect(() => {
    if (!voiceSessionActive) return
    const wasPlaying = prevAutoplayRef.current !== undefined
    const isPlaying = autoplayPlaying !== undefined

    if (isPlaying && !wasPlaying) {
      voice.notifyPlaybackStarted().catch(() => {})
    } else if (!isPlaying && wasPlaying) {
      voice.notifyPlaybackFinished().catch(() => {})
    }
    prevAutoplayRef.current = autoplayPlaying
  }, [voiceSessionActive, autoplayPlaying, voice.notifyPlaybackStarted, voice.notifyPlaybackFinished])

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (prevActiveRef.current) {
        voice.stopSession().catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
})

export default VoiceSession
