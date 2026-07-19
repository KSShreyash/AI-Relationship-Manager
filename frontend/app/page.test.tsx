import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { pushMock, getSessionMock, routerMock } = vi.hoisted(() => {
  const pushMock = vi.fn()
  return { pushMock, getSessionMock: vi.fn(), routerMock: { push: pushMock } }
})

vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: getSessionMock } }),
}))

import Home from './page'

describe('Home', () => {
  beforeEach(() => {
    pushMock.mockReset()
    getSessionMock.mockReset()
  })

  it('redirects to the dashboard when a session exists', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'token' } } })

    render(<Home />)

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/dashboard'))
  })

  it('redirects to login when there is no session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })

    render(<Home />)

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/login'))
  })
})
