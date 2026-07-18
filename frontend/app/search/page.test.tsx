import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))

import SearchPage from './page'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('SearchPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('shows a prompt before any query is typed', () => {
    render(<SearchPage />)

    expect(screen.getByText(/type to search/i)).toBeInTheDocument()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('debounces the query and shows grouped results', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        contacts: [
          { id: 'c1', display_name: 'Alice Johnson', email_address: 'alice@example.com', notes: 'Discussed the budget' },
        ],
        action_items: [
          { id: 'a1', text: 'Follow up with Alice', direction: 'mine', status: 'open', due_date: null,
            contact: { id: 'c1', display_name: 'Alice Johnson', email_address: 'alice@example.com' } },
        ],
      })
    )

    render(<SearchPage />)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'alice' } })
    await vi.advanceTimersByTimeAsync(300)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/search?q=alice')
    await vi.waitFor(() => expect(screen.getByText(/follow up with alice/i)).toBeInTheDocument())

    const contactsHeading = screen.getByRole('heading', { name: /^contacts$/i })
    const contactsList = contactsHeading.nextElementSibling as HTMLElement
    expect(within(contactsList).getByRole('link', { name: /alice johnson/i })).toHaveAttribute('href', '/contacts/c1')
    expect(screen.getByText(/discussed the budget/i)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('shows empty-state copy per section when a search returns nothing', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(jsonResponse({ contacts: [], action_items: [] }))

    render(<SearchPage />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'nomatch' } })
    await vi.advanceTimersByTimeAsync(300)

    await vi.waitFor(() => expect(screen.getByText(/no matching contacts/i)).toBeInTheDocument())
    expect(screen.getByText(/no matching action items/i)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('shows an inline error and keeps prior results on failure', async () => {
    vi.useFakeTimers()
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({
        contacts: [{ id: 'c1', display_name: 'Kept Contact', email_address: null, notes: null }],
        action_items: [],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))

    render(<SearchPage />)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'kept' } })
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => expect(screen.getByText('Kept Contact')).toBeInTheDocument())

    fireEvent.change(input, { target: { value: 'kept2' } })
    await vi.advanceTimersByTimeAsync(300)

    await vi.waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
    expect(screen.getByText('Kept Contact')).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('debounces search input and ignores a stale out-of-order response', async () => {
    vi.useFakeTimers()

    let resolveFirst: (value: Response) => void = () => {}
    let resolveSecond: (value: Response) => void = () => {}
    apiFetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve })) // "sm"
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve })) // "smi"

    render(<SearchPage />)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'sm' } })
    await vi.advanceTimersByTimeAsync(300)
    fireEvent.change(input, { target: { value: 'smi' } })
    await vi.advanceTimersByTimeAsync(300)

    resolveSecond(jsonResponse({
      contacts: [{ id: '2', display_name: 'Smith', email_address: null, notes: null }],
      action_items: [],
    }))
    await vi.waitFor(() => expect(screen.getByText('Smith')).toBeInTheDocument())

    resolveFirst(jsonResponse({
      contacts: [{ id: '3', display_name: 'Smiley', email_address: null, notes: null }],
      action_items: [],
    }))
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByText('Smith')).toBeInTheDocument()
    expect(screen.queryByText('Smiley')).not.toBeInTheDocument()

    vi.useRealTimers()
  })
})
