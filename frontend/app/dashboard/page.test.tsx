import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, pushMock, routerMock } = vi.hoisted(() => {
  const pushMock = vi.fn()
  return { apiFetchMock: vi.fn(), pushMock, routerMock: { push: pushMock } }
})

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }))

import DashboardPage from './page'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

const DASHBOARD_BODY = {
  contact_count: 3,
  open_action_item_count: 2,
  activity: [
    { type: 'action_item_created', id: 'a1', timestamp: '2026-07-17T10:00:00Z', text: 'Send the deck', direction: 'mine' },
    { type: 'contact_updated', id: 'c1', timestamp: '2026-07-17T09:00:00Z', display_name: 'Helen', email_address: 'helen@example.com' },
  ],
}

describe('DashboardPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    pushMock.mockReset()
  })

  it('redirects to login on a 401 (no session)', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(new Response(null, { status: 401 }))
      }
      return Promise.resolve(jsonResponse(DASHBOARD_BODY))
    })

    render(<DashboardPage />)

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/login'))
  })

  it('shows connection status, stats, and activity feed', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(jsonResponse({ graph_me: { mail: 'user@example.com' } }))
      }
      if (path === '/api/dashboard') {
        return Promise.resolve(jsonResponse(DASHBOARD_BODY))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<DashboardPage />)

    await waitFor(() => expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument())
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText(/Send the deck/)).toBeInTheDocument()
    expect(screen.getByText(/Helen/)).toBeInTheDocument()
  })

  it('shows a reconnect prompt on 409 needs_reauth', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(new Response(null, { status: 409 }))
      }
      return Promise.resolve(jsonResponse(DASHBOARD_BODY))
    })

    render(<DashboardPage />)

    await waitFor(() =>
      expect(screen.getByText(/reconnect your microsoft account/i)).toBeInTheDocument()
    )
  })

  it('triggers a sync and refetches the dashboard on success', async () => {
    const user = userEvent.setup()
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(jsonResponse({ graph_me: { mail: 'user@example.com' } }))
      }
      if (path === '/api/dashboard') {
        return Promise.resolve(jsonResponse(DASHBOARD_BODY))
      }
      if (path === '/api/sync/run/me' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ status: 'ok' }))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /sync now/i }))

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/sync/run/me', { method: 'POST' })
    )
  })

  it('shows an inline error and re-enables the button when sync fails', async () => {
    const user = userEvent.setup()
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(jsonResponse({ graph_me: { mail: 'user@example.com' } }))
      }
      if (path === '/api/dashboard') {
        return Promise.resolve(jsonResponse(DASHBOARD_BODY))
      }
      if (path === '/api/sync/run/me' && init?.method === 'POST') {
        return Promise.resolve(new Response(null, { status: 500 }))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument())

    const button = screen.getByRole('button', { name: /sync now/i })
    await user.click(button)

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
    expect(button).not.toBeDisabled()
  })
})
