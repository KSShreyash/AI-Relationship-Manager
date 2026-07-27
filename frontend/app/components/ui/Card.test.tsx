import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Card } from './Card'

describe('Card', () => {
  it('renders its children inside a bordered surface', () => {
    render(<Card>Contents</Card>)
    const card = screen.getByText('Contents').parentElement
    expect(card).toHaveClass('border-[var(--color-border)]')
    expect(card).toHaveClass('bg-[var(--color-surface)]')
  })

  it('adds hover-lift classes only when hoverable is true', () => {
    render(<Card>Plain</Card>)
    expect(screen.getByText('Plain').parentElement).not.toHaveClass('hover:-translate-y-0.5')

    render(<Card hoverable>Hoverable</Card>)
    expect(screen.getByText('Hoverable').parentElement).toHaveClass('hover:-translate-y-0.5')
  })
})
