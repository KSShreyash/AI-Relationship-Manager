import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))

import DashboardPage from './page'

describe('DashboardPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('shows the connected email on success', async () => {
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ graph_me: { mail: 'user@example.com' } }), { status: 200 })
    )

    render(<DashboardPage />)

    await waitFor(() =>
      expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument()
    )
  })

  it('shows a reconnect prompt on 409 needs_reauth', async () => {
    apiFetchMock.mockResolvedValue(new Response(null, { status: 409 }))

    render(<DashboardPage />)

    await waitFor(() =>
      expect(screen.getByText(/reconnect your microsoft account/i)).toBeInTheDocument()
    )
  })
})
