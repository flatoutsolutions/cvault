/**
 * auditEvent — presentation helpers that turn a raw audit feed event into the
 * plain-language label, status, and routine-classification the audit page
 * renders. Pure functions, unit-tested here.
 */
import { describe, expect, it } from 'vitest'

import type { ActivityEvent, AuditEvent } from './auditEvent'
import { describeEvent, eventStatus, isRoutine } from './auditEvent'

function activity(action: ActivityEvent['action']): AuditEvent {
  return { kind: 'activity', id: 'a', at: 1, action, machineId: 'm' }
}
function refresh(outcome: 'success' | 'failure' | 'reloginRequired'): AuditEvent {
  return { kind: 'refresh', id: 'r', at: 1, outcome, triggeredBy: 'onUse' }
}

describe('describeEvent', () => {
  it('maps CLI actions to plain language', () => {
    expect(describeEvent(activity('switch'))).toBe('Switched subscription')
    expect(describeEvent(activity('add'))).toBe('Added subscription')
    expect(describeEvent(activity('remove'))).toBe('Removed subscription')
    expect(describeEvent(activity('rename'))).toBe('Renamed subscription')
    expect(describeEvent(activity('login'))).toBe('Signed in')
    expect(describeEvent(activity('pull'))).toBe('Synced credentials')
    expect(describeEvent(activity('export'))).toBe('Exported a backup')
    expect(describeEvent(activity('import'))).toBe('Imported a backup')
    expect(describeEvent(activity('rotate'))).toBe('Rotated encryption key')
    expect(describeEvent(activity('refresh'))).toBe('Refreshed token')
  })

  it('maps refresh outcomes to plain language', () => {
    expect(describeEvent(refresh('success'))).toBe('Token refreshed')
    expect(describeEvent(refresh('failure'))).toBe('Token refresh failed')
    expect(describeEvent(refresh('reloginRequired'))).toBe('Re-login required')
  })
})

describe('eventStatus', () => {
  it('treats all CLI activity as ok', () => {
    expect(eventStatus(activity('switch'))).toBe('ok')
    expect(eventStatus(activity('export'))).toBe('ok')
  })

  it('maps refresh outcomes to ok / failed / attention', () => {
    expect(eventStatus(refresh('success'))).toBe('ok')
    expect(eventStatus(refresh('failure'))).toBe('failed')
    expect(eventStatus(refresh('reloginRequired'))).toBe('attention')
  })
})

describe('isRoutine', () => {
  it('treats successful auto-refreshes and bulk syncs as routine noise', () => {
    expect(isRoutine(refresh('success'))).toBe(true)
    expect(isRoutine(activity('pull'))).toBe(true)
  })

  it('treats failures, relogin, and meaningful CLI actions as non-routine', () => {
    expect(isRoutine(refresh('failure'))).toBe(false)
    expect(isRoutine(refresh('reloginRequired'))).toBe(false)
    expect(isRoutine(activity('switch'))).toBe(false)
    expect(isRoutine(activity('add'))).toBe(false)
    expect(isRoutine(activity('login'))).toBe(false)
  })
})
