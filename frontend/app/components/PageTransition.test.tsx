import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}))

import { PageTransition } from './PageTransition'

describe('PageTransition', () => {
  it('renders its children', () => {
    render(
      <PageTransition>
        <p>Page content</p>
      </PageTransition>
    )
    expect(screen.getByText('Page content')).toBeInTheDocument()
  })
})
