import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSessionMock = vi.fn()

vi.mock('./supabase/client', () => ({
  createClient: () => ({ auth: { getSession: getSessionMock } }),
}))

import { apiFetch } from './api'

describe('apiFetch', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_API_BASE_URL = 'https://api.example.com'
    getSessionMock.mockReset()
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
  })

  it('attaches the Supabase access token as a Bearer header', async () => {
    getSessionMock.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } })

    await apiFetch('/api/me/graph-status')

    const call = (global.fetch as any).mock.calls[0]
    expect(call[0]).toBe('https://api.example.com/api/me/graph-status')
    const headers: Headers = call[1].headers
    expect(headers.get('Authorization')).toBe('Bearer jwt-123')
  })

  it('omits the Authorization header when there is no session', async () => {
    getSessionMock.mockResolvedValue({ data: { session: null } })

    await apiFetch('/api/me/graph-status')

    const call = (global.fetch as any).mock.calls[0]
    const headers: Headers = call[1].headers
    expect(headers.get('Authorization')).toBeNull()
  })
})
