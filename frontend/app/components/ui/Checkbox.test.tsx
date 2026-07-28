import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Checkbox } from './Checkbox'

describe('Checkbox', () => {
  it('renders unchecked with the given aria-label', () => {
    render(<Checkbox checked={false} onChange={vi.fn()} aria-label="Mark done" />)
    expect(screen.getByRole('checkbox', { name: 'Mark done' })).not.toBeChecked()
  })

  it('renders checked', () => {
    render(<Checkbox checked={true} onChange={vi.fn()} aria-label="Reopen" />)
    expect(screen.getByRole('checkbox', { name: 'Reopen' })).toBeChecked()
  })

  it('calls onChange when clicked', () => {
    const onChange = vi.fn()
    render(<Checkbox checked={false} onChange={onChange} aria-label="Mark done" />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark done' }))
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
