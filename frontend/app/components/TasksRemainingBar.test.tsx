import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TasksRemainingBar } from './TasksRemainingBar'

describe('TasksRemainingBar', () => {
  it('shows "No tasks yet" when total is 0', () => {
    render(<TasksRemainingBar open={0} total={0} />)
    expect(screen.getByText('No tasks yet')).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '0 open of 0 total tasks')
  })

  it('shows the open/total label', () => {
    render(<TasksRemainingBar open={2} total={10} />)
    expect(screen.getByText('2 open of 10 total')).toBeInTheDocument()
  })

  it('sizes the fill bar to the open ratio', () => {
    render(<TasksRemainingBar open={3} total={10} />)
    const fill = screen.getByRole('img').firstChild as HTMLElement
    expect(fill.style.width).toBe('30%')
  })

  it('uses the green zone color when the open ratio is 0.33 or below', () => {
    render(<TasksRemainingBar open={3} total={10} />)
    const fill = screen.getByRole('img').firstChild as HTMLElement
    expect(fill.style.backgroundColor).toBe('var(--color-accent)')
  })

  it('uses the amber zone color when the open ratio is between 0.33 and 0.66', () => {
    render(<TasksRemainingBar open={5} total={10} />)
    const fill = screen.getByRole('img').firstChild as HTMLElement
    expect(fill.style.backgroundColor).toBe('var(--color-warning)')
  })

  it('uses the red zone color when the open ratio is above 0.66', () => {
    render(<TasksRemainingBar open={8} total={10} />)
    const fill = screen.getByRole('img').firstChild as HTMLElement
    expect(fill.style.backgroundColor).toBe('var(--color-danger)')
  })
})
