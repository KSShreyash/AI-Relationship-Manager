import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TasksRemainingGauge } from './TasksRemainingGauge'

describe('TasksRemainingGauge', () => {
  it('shows "No tasks yet" when total is 0', () => {
    render(<TasksRemainingGauge open={0} total={0} />)
    expect(screen.getByText('No tasks yet')).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '0 open of 0 total tasks')
  })

  it('shows the open/total label', () => {
    render(<TasksRemainingGauge open={2} total={10} />)
    expect(screen.getByText('2 open of 10 total')).toBeInTheDocument()
  })

  it('uses the green zone color when the open ratio is 0.33 or below', () => {
    const { container } = render(<TasksRemainingGauge open={3} total={10} />)
    const progressPath = container.querySelectorAll('path')[1]
    expect(progressPath).toHaveAttribute('stroke', 'var(--color-accent)')
  })

  it('uses the amber zone color when the open ratio is between 0.33 and 0.66', () => {
    const { container } = render(<TasksRemainingGauge open={5} total={10} />)
    const progressPath = container.querySelectorAll('path')[1]
    expect(progressPath).toHaveAttribute('stroke', 'var(--color-warning)')
  })

  it('uses the red zone color when the open ratio is above 0.66', () => {
    const { container } = render(<TasksRemainingGauge open={8} total={10} />)
    const progressPath = container.querySelectorAll('path')[1]
    expect(progressPath).toHaveAttribute('stroke', 'var(--color-danger)')
  })
})
