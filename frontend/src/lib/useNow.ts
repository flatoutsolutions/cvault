import { useEffect, useState } from 'react'

/**
 * Current epoch-ms that re-renders every `intervalMs`, so time-derived UI
 * (reset countdowns, "checked Xm ago" staleness) stays current on a tab left
 * open.
 *
 * Without this, a component only re-renders when Convex pushes new data — but a
 * FAILING usage poll writes nothing, so the row never changes and a value would
 * freeze and silently rot (a countdown stuck at "2m", a "Ready" that's hours
 * stale). Ticking `now` lets the UI age the data on its own.
 *
 * Default 60s: usage polls run every 5 minutes, so minute granularity is ample
 * and keeps re-renders cheap.
 */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = () => {
      setNow(Date.now())
    }
    const id = setInterval(tick, intervalMs)
    // Background tabs throttle timers, so a tab resumed after a long sleep can
    // be up to `intervalMs` stale on the next paint. Re-stamp immediately on
    // refocus so the dashboard is correct the moment the user looks at it.
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [intervalMs])
  return now
}
