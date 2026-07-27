import { describe, expect, it } from 'vitest'

import { getInitials } from './getInitials'

describe('getInitials', () => {
  it('uses the first letters of the first two words of the display name', () => {
    expect(getInitials('Jane Doe', 'jane@example.com')).toBe('JD')
  })

  it('uses only one letter for a single-word display name', () => {
    expect(getInitials('Cher', 'cher@example.com')).toBe('C')
  })

  it('falls back to the first letter of the email when there is no display name', () => {
    expect(getInitials(null, 'jane@example.com')).toBe('J')
  })

  it('falls back to a question mark when there is no display name or email', () => {
    expect(getInitials(null, null)).toBe('?')
  })
})
