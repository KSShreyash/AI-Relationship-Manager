import { describe, expect, it } from 'vitest'

import { formatRelativeTime } from './formatRelativeTime'

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-27T12:00:00Z')

  it('returns "just now" for under a minute', () => {
    expect(formatRelativeTime('2026-07-27T11:59:45Z', now)).toBe('just now')
  })

  it('returns minutes for under an hour', () => {
    expect(formatRelativeTime('2026-07-27T11:45:00Z', now)).toBe('15m ago')
  })

  it('returns hours for under a day', () => {
    expect(formatRelativeTime('2026-07-27T06:00:00Z', now)).toBe('6h ago')
  })

  it('returns days for under a month', () => {
    expect(formatRelativeTime('2026-07-17T12:00:00Z', now)).toBe('10d ago')
  })

  it('returns months for under a year', () => {
    expect(formatRelativeTime('2026-01-27T12:00:00Z', now)).toBe('6mo ago')
  })

  it('returns years for a year or more', () => {
    expect(formatRelativeTime('2024-07-27T12:00:00Z', now)).toBe('2y ago')
  })
})
