import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Badge } from './Badge'

describe('Badge', () => {
  it('renders its children', () => {
    render(<Badge>3 open</Badge>)
    expect(screen.getByText('3 open')).toBeInTheDocument()
  })

  it('applies the accent variant', () => {
    render(<Badge variant="accent">Active</Badge>)
    expect(screen.getByText('Active')).toHaveClass('text-[var(--color-accent)]')
  })

  it('applies the muted variant', () => {
    render(<Badge variant="muted">Idle</Badge>)
    expect(screen.getByText('Idle')).toHaveClass('text-[var(--color-muted)]')
  })

  it('applies the danger variant', () => {
    render(<Badge variant="danger">Overdue</Badge>)
    expect(screen.getByText('Overdue')).toHaveClass('text-[var(--color-danger)]')
  })

  it('defaults to the muted variant', () => {
    render(<Badge>Default</Badge>)
    expect(screen.getByText('Default')).toHaveClass('text-[var(--color-muted)]')
  })
})
