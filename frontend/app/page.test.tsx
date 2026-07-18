import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pushMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import Home from './page'

describe('Home', () => {
  beforeEach(() => {
    pushMock.mockReset()
  })

  it('redirects to the dashboard', () => {
    render(<Home />)

    expect(pushMock).toHaveBeenCalledWith('/dashboard')
    expect(screen.getByText(/redirecting/i)).toBeInTheDocument()
  })
})
