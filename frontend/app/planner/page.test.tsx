import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, pushMock, routerMock } = vi.hoisted(() => {
  const pushMock = vi.fn()
  return { apiFetchMock: vi.fn(), pushMock, routerMock: { push: pushMock } }
})

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }))

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
    pushMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows an inline error instead of failing silently when the fetch throws', async () => {
    apiFetchMock.mockRejectedValue(new Error('network error'))

    render(<PlannerPage />)

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
  })

  it('redirects to login on a 401 (no session)', async () => {
    apiFetchMock.mockResolvedValue(new Response(null, { status: 401 }))

    render(<PlannerPage />)

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/login'))
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

  it('shows a Schedule control on open items with a contact and hides it once scheduled', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse([
      {
        id: '10', text: 'Call Gina', direction: 'mine', status: 'open', due_date: null,
        contact: { id: 'c1', display_name: 'Gina', email_address: 'gina@example.com' },
        scheduled_calendar_event_id: null, scheduled_start_time: null,
        created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
      },
      {
        id: '11', text: 'Already booked', direction: 'mine', status: 'open', due_date: null,
        contact: { id: 'c2', display_name: 'Bob', email_address: 'bob@example.com' },
        scheduled_calendar_event_id: 'evt-1', scheduled_start_time: '2026-07-22T14:00:00Z',
        created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
      },
    ]))

    render(<PlannerPage />)

    await waitFor(() => expect(screen.getByText(/Call Gina/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^schedule$/i })).toBeInTheDocument()
    expect(screen.getByText(/scheduled:/i)).toBeInTheDocument()
  })
})
