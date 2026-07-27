import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Card } from './Card'

describe('Card', () => {
  it('renders its children inside a bordered surface', () => {
    const { container } = render(<Card>Contents</Card>)
    const card = container.firstChild
    expect(card).toHaveClass('border-[var(--color-border)]')
    expect(card).toHaveClass('bg-[var(--color-surface)]')
    expect(screen.getByText('Contents')).toBeInTheDocument()
  })

  it('adds hover-lift classes only when hoverable is true', () => {
    const plain = render(<Card>Plain</Card>)
    expect(plain.container.firstChild).not.toHaveClass('hover:-translate-y-0.5')

    const hoverable = render(<Card hoverable>Hoverable</Card>)
    expect(hoverable.container.firstChild).toHaveClass('hover:-translate-y-0.5')
  })
})
