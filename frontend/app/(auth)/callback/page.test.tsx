import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()
const { pushMock, routerMock } = vi.hoisted(() => {
  const pushMock = vi.fn()
  return { pushMock, routerMock: { push: pushMock } }
})

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: getSessionMock } }),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}))

import CallbackPage from './page'

describe('CallbackPage', () => {
  beforeEach(() => {
    getSessionMock.mockReset()
    pushMock.mockReset()
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com'
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  })

  it('forwards Graph tokens to the backend and redirects to the dashboard', async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: 'supabase-jwt',
          provider_token: 'graph-access',
          provider_refresh_token: 'graph-refresh',
        },
      },
      error: null,
    })

    render(<CallbackPage />)

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dashboard'))
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.example.com/api/auth/graph-tokens',
      expect.objectContaining({ method: 'POST' })
    )

    const [, requestInit] = (global.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0]
    const body = JSON.parse(requestInit.body as string)
    expect(body.scopes).toEqual([
      'User.Read',
      'Mail.Read',
      'Chat.Read',
      'Calendars.ReadWrite',
      'OnlineMeetings.ReadWrite',
    ])
  })

  it('shows an error message when Microsoft does not return Graph tokens', async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: 'supabase-jwt' } },
      error: null,
    })

    render(<CallbackPage />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
  })

  it('shows an error instead of hanging when the graph-tokens request fails', async () => {
    getSessionMock.mockResolvedValue({
      data: {
        session: {
          access_token: 'supabase-jwt',
          provider_token: 'graph-access',
          provider_refresh_token: 'graph-refresh',
        },
      },
      error: null,
    })
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))

    render(<CallbackPage />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(pushMock).not.toHaveBeenCalled()
  })
})
