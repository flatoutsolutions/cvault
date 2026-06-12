import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNow } from './useNow'

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('advances the returned time on each interval tick', () => {
    const { result } = renderHook(() => useNow(1000))
    const first = result.current
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBeGreaterThan(first)
  })

  it('clears its interval on unmount', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const { unmount } = renderHook(() => useNow(1000))
    unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })

  it('re-stamps immediately when the tab becomes visible again', () => {
    const { result } = renderHook(() => useNow(60_000))
    const first = result.current
    // Advance the clock WITHOUT firing the interval (shorter than the period),
    // then simulate a refocus — the value should jump without waiting 60s.
    act(() => {
      vi.advanceTimersByTime(5_000)
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(result.current).toBeGreaterThan(first)
  })
})
