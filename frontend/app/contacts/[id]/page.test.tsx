import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, useParamsMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
  useParamsMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))
vi.mock('next/navigation', () => ({ useParams: useParamsMock }))

import ContactProfilePage from './page'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('ContactProfilePage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    useParamsMock.mockReturnValue({ id: 'contact-1' })
  })

  it('renders notes and splits action items into open and done sections', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/contacts/contact-1') {
        return Promise.resolve(jsonResponse({
          id: 'contact-1', email_address: 'alice@example.com', display_name: 'Alice',
          notes: 'Works at Acme.', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-17T00:00:00Z',
        }))
      }
      if (path === '/api/contacts/contact-1/action-items') {
        return Promise.resolve(jsonResponse([
          { id: 'ai-1', text: 'Send the deck', direction: 'mine', status: 'open', due_date: null, source_type: 'email', created_at: '2026-07-17T00:00:00Z', updated_at: '2026-07-17T00:00:00Z' },
          { id: 'ai-2', text: 'Follow up call', direction: 'theirs', status: 'done', due_date: null, source_type: 'email', created_at: '2026-07-16T00:00:00Z', updated_at: '2026-07-16T00:00:00Z' },
        ]))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<ContactProfilePage />)

    await waitFor(() => expect(screen.getByText('Works at Acme.')).toBeInTheDocument())
    expect(screen.getByText('Send the deck')).toBeInTheDocument()
    expect(screen.getByText('Follow up call')).toBeInTheDocument()
  })

  it('shows a not-found message on 404', async () => {
    apiFetchMock.mockResolvedValue(new Response(null, { status: 404 }))

    render(<ContactProfilePage />)

    await waitFor(() => expect(screen.getByText(/contact not found/i)).toBeInTheDocument())
  })
})
