import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signOutMock = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: signOutMock } }),
}))

let mockPathname = '/dashboard'
const pushMock = vi.fn()

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: pushMock }),
}))

import NavBar from './NavBar'

describe('NavBar', () => {
  beforeEach(() => {
    signOutMock.mockReset()
    pushMock.mockReset()
    window.localStorage.clear()
    mockPathname = '/dashboard'
  })

  it('renders nothing on chrome-hidden paths', () => {
    mockPathname = '/login'
    const { container } = render(<NavBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders all nav links with the correct hrefs', () => {
    render(<NavBar />)
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/dashboard')
    expect(screen.getByRole('link', { name: /contacts/i })).toHaveAttribute('href', '/contacts')
    expect(screen.getByRole('link', { name: /planner/i })).toHaveAttribute('href', '/planner')
    expect(screen.getByRole('link', { name: /search/i })).toHaveAttribute('href', '/search')
  })

  it('marks only the active link with aria-current', () => {
    mockPathname = '/contacts'
    render(<NavBar />)
    expect(screen.getByRole('link', { name: /contacts/i })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /dashboard/i })).not.toHaveAttribute('aria-current')
  })

  it('signs out and redirects to login on click', async () => {
    render(<NavBar />)
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/login'))
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })

  it('toggles collapsed state and persists it to localStorage', () => {
    render(<NavBar />)
    const toggle = screen.getByRole('button', { name: /collapse sidebar/i })

    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument()
    expect(window.localStorage.getItem('nav-collapsed')).toBe('true')
  })

  it('restores collapsed state from localStorage on mount', () => {
    window.localStorage.setItem('nav-collapsed', 'true')
    render(<NavBar />)
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument()
  })
})
