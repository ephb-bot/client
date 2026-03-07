import * as React from 'react'
import {Audio, type AVPlaybackStatus} from 'expo-av'
import type {Props} from './audio-video'

const AudioVideo = (props: Props) => {
  const {url, paused, onPositionUpdated, onEnded} = props
  const [sound, setSound] = React.useState<Audio.Sound | undefined>()

  // Clean up sound on unmount or when sound instance changes
  React.useEffect(() => {
    return () => {
      sound
        ?.unloadAsync()
        .then(() => {})
        .catch(() => {})
    }
  }, [sound])

  const onPlaybackStatusUpdate = React.useCallback(
    (e: AVPlaybackStatus) => {
      if (!e.isLoaded) return
      if (e.isPlaying) {
        const ct = e.positionMillis
        const dur = e.durationMillis ?? 0
        if (dur === 0) {
          return
        }
        onPositionUpdated(ct / dur)
      } else if (e.didJustFinish) {
        onEnded()
        sound
          ?.setPositionAsync(0)
          .then(() => {})
          .catch(() => {})
      }
    },
    [onPositionUpdated, onEnded, sound]
  )

  React.useEffect(() => {
    sound?.setOnPlaybackStatusUpdate(onPlaybackStatusUpdate)
  }, [sound, onPlaybackStatusUpdate])

  // Handle paused state changes via useEffect (not during render)
  const lastPausedRef = React.useRef(paused)
  const soundRef = React.useRef(sound)
  soundRef.current = sound

  React.useEffect(() => {
    if (lastPausedRef.current === paused) return
    lastPausedRef.current = paused

    const f = async () => {
      let s = soundRef.current
      if (!s) {
        const {sound: newSound} = await Audio.Sound.createAsync({uri: url})
        s = newSound
        setSound(newSound)
        await newSound.setProgressUpdateIntervalAsync(100)
      }

      if (paused) {
        await s?.pauseAsync()
      } else {
        await s?.playAsync()
      }
    }
    f()
      .then(() => {})
      .catch((e: unknown) => {
        console.error('audio play fail', e)
      })
  }, [paused, url])

  // When url arrives after mount and we're already unpaused (autoplay),
  // kick off playback - the paused effect won't re-fire because paused
  // didn't change, only the url did.
  const lastUrlRef = React.useRef(url)
  React.useEffect(() => {
    if (lastUrlRef.current === url) return
    lastUrlRef.current = url
    if (!paused && url.length > 0) {
      const f = async () => {
        let s = soundRef.current
        if (!s) {
          const {sound: newSound} = await Audio.Sound.createAsync({uri: url})
          s = newSound
          setSound(newSound)
          await newSound.setProgressUpdateIntervalAsync(100)
        }
        await s?.playAsync()
      }
      f()
        .then(() => {})
        .catch((e: unknown) => {
          console.error('audio autoplay url-change fail', e)
        })
    }
  }, [url, paused])

  return null
}

export default AudioVideo
