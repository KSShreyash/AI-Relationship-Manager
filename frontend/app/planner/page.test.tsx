import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))

import PlannerPage from './page'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

const TODAY = new Date('2026-07-17T12:00:00Z')

const ITEMS = [
  { id: '1', text: 'Overdue task', direction: 'mine', status: 'open', due_date: '2026-07-10', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
  { id: '2', text: 'Due this week', direction: 'theirs', status: 'open', due_date: '2026-07-19', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
  { id: '3', text: 'No due date task', direction: 'mine', status: 'open', due_date: null, contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
]

describe('PlannerPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(TODAY)
    apiFetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('groups open items into Overdue, Due this week, and No due date sections', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(ITEMS))

    render(<PlannerPage />)

    await waitFor(() => expect(screen.getByText('Overdue task')).toBeInTheDocument())
    expect(screen.getByText('Due this week', { selector: 'li' })).toBeInTheDocument()
    expect(screen.getByText('No due date task')).toBeInTheDocument()
  })

  it('refetches with include_done=true when the show-completed toggle is checked', async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve(jsonResponse(ITEMS)))

    render(<PlannerPage />)
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('checkbox', { name: /show completed/i }))

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenLastCalledWith('/api/action-items?include_done=true')
    )
  })

  it('marks an item done and refetches the list', async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...ITEMS[0], status: 'done' }))
      }
      return Promise.resolve(jsonResponse(ITEMS))
    })

    render(<PlannerPage />)
    await waitFor(() => expect(screen.getByText('Overdue task')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('button', { name: /mark done/i })[0])

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/action-items/1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      })
    )
  })

  it('shows an inline error and leaves the item unchanged when the PATCH fails', async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(new Response(null, { status: 500 }))
      }
      return Promise.resolve(jsonResponse(ITEMS))
    })

    render(<PlannerPage />)
    await waitFor(() => expect(screen.getByText('Overdue task')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('button', { name: /mark done/i })[0])

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
    expect(screen.getByText('Overdue task')).toBeInTheDocument()
  })

  it('shows the Later group, the Completed section, and a contact name when present', async () => {
    const EXTENDED_ITEMS = [
      { id: '4', text: 'Later task', direction: 'mine', status: 'open', due_date: '2026-08-01', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
      { id: '5', text: 'Done task', direction: 'mine', status: 'done', due_date: '2026-07-15', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
      { id: '6', text: 'Contact task', direction: 'theirs', status: 'open', due_date: null, contact: { id: 'c1', display_name: 'Dana', email_address: 'dana@example.com' }, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
    ]
    apiFetchMock.mockImplementation(() => Promise.resolve(jsonResponse(EXTENDED_ITEMS)))

    render(<PlannerPage />)

    await waitFor(() => expect(screen.getByText('Later task')).toBeInTheDocument())

    const laterHeading = screen.getByRole('heading', { name: 'Later' })
    expect(within(laterHeading.nextElementSibling as HTMLElement).getByText('Later task')).toBeInTheDocument()

    expect(screen.getByText(/Dana/)).toBeInTheDocument()

    expect(screen.queryByText('Done task')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Completed' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: /show completed/i }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Completed' })).toBeInTheDocument())
    const completedHeading = screen.getByRole('heading', { name: 'Completed' })
    expect(within(completedHeading.nextElementSibling as HTMLElement).getByText('Done task')).toBeInTheDocument()
  })
})
