import * as React from 'react'
import type {Props} from './audio-video'

const AudioVideo = (props: Props) => {
  const {url, paused, onPositionUpdated, onEnded} = props
  const vidRef = React.useRef<HTMLVideoElement | null>(null)

  const onTimeUpdate = React.useCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => {
      const ct = e.currentTarget.currentTime
      const dur = e.currentTarget.duration
      if (dur === 0) {
        return
      }
      onPositionUpdated(ct / dur)
    },
    [onPositionUpdated]
  )

  const onEndedRaw = React.useCallback(() => {
    onEnded()
  }, [onEnded])

  const lastPausedRef = React.useRef(paused)
  React.useEffect(() => {
    if (lastPausedRef.current === paused) {
      return
    }
    lastPausedRef.current = paused
    if (paused) {
      vidRef.current?.pause()
    } else {
      vidRef.current
        ?.play()
        .then(() => {})
        .catch(() => {})
    }
  }, [paused])

  // When url arrives (e.g. service provides it after mount) and we're already
  // unpaused (autoplay), kick off playback — the paused effect won't re-fire
  // because paused didn't change, only the src did.
  const lastUrlRef = React.useRef(url)
  React.useEffect(() => {
    if (lastUrlRef.current === url) return
    lastUrlRef.current = url
    if (!paused && url.length > 0) {
      vidRef.current
        ?.play()
        .then(() => {})
        .catch(() => {})
    }
  }, [url, paused])

  return (
    <video
      ref={vidRef}
      src={url}
      style={{height: 0, width: 0}}
      onTimeUpdate={onTimeUpdate}
      onEnded={onEndedRaw}
    />
  )
}

export default AudioVideo
