import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signInWithOAuthMock = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithOAuth: signInWithOAuthMock } }),
}))

import LoginPage from './page'

describe('LoginPage', () => {
  beforeEach(() => {
    signInWithOAuthMock.mockReset()
  })

  it('starts the Microsoft OAuth flow with the required Graph scopes on click', () => {
    render(<LoginPage />)

    fireEvent.click(screen.getByRole('button', { name: /sign in with microsoft/i }))

    expect(signInWithOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'azure',
        options: expect.objectContaining({
          scopes: expect.stringContaining('Mail.Read'),
          redirectTo: expect.stringContaining('/callback'),
        }),
      })
    )
  })

  it('renders the hero headline and feature bullets', () => {
    render(<LoginPage />)

    expect(
      screen.getByRole('heading', { name: /stop losing relationships/i })
    ).toBeInTheDocument()
    expect(screen.getByText(/extracts action items from email & calendar/i)).toBeInTheDocument()
    expect(screen.getByText(/tracks who owes who what/i)).toBeInTheDocument()
    expect(screen.getByText(/books follow-ups directly on your calendar/i)).toBeInTheDocument()
  })
})
