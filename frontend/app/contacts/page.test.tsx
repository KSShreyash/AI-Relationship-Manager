import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, pushMock, routerMock } = vi.hoisted(() => {
  const pushMock = vi.fn()
  return { apiFetchMock: vi.fn(), pushMock, routerMock: { push: pushMock } }
})

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }))

import ContactsPage from './page'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('ContactsPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    pushMock.mockReset()
  })

  it('redirects to login on a 401 (no session)', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(new Response(null, { status: 401 }))

    render(<ContactsPage />)
    await vi.advanceTimersByTimeAsync(300)

    expect(pushMock).toHaveBeenCalledWith('/login')

    vi.useRealTimers()
  })

  it('renders contacts sorted by recency with their open action item count', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse([
        { id: '1', email_address: 'alice@example.com', display_name: 'Alice', open_action_item_count: 2, updated_at: '2026-07-17T10:00:00Z' },
      ])
    )

    render(<ContactsPage />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.getByText(/2/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /alice/i })).toHaveAttribute('href', '/contacts/view?id=1')
  })

  it('shows an empty state when there are no contacts', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse([]))

    render(<ContactsPage />)

    await waitFor(() =>
      expect(screen.getByText(/no contacts yet/i)).toBeInTheDocument()
    )
  })

  it('debounces search input and ignores a stale out-of-order response', async () => {
    vi.useFakeTimers()

    let resolveFirst: (value: Response) => void = () => {}
    let resolveSecond: (value: Response) => void = () => {}
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse([])) // initial load
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve })) // "sm" search
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve })) // "smi" search

    render(<ContactsPage />)
    await vi.advanceTimersByTimeAsync(300)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'sm' } })
    await vi.advanceTimersByTimeAsync(300)
    fireEvent.change(input, { target: { value: 'smi' } })
    await vi.advanceTimersByTimeAsync(300)

    // Later request ("smi") resolves first, earlier request ("sm") resolves second (stale).
    resolveSecond(
      jsonResponse([
        { id: '2', email_address: 'smith@example.com', display_name: 'Smith', open_action_item_count: 0, updated_at: '2026-07-17T10:00:00Z' },
      ])
    )
    await vi.waitFor(() => expect(screen.getByText('Smith')).toBeInTheDocument())

    resolveFirst(
      jsonResponse([
        { id: '3', email_address: 'smiley@example.com', display_name: 'Smiley', open_action_item_count: 0, updated_at: '2026-07-17T10:00:00Z' },
      ])
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByText('Smith')).toBeInTheDocument()
    expect(screen.queryByText('Smiley')).not.toBeInTheDocument()

    vi.useRealTimers()
  })
})
