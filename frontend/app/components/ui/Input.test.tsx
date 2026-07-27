import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Input } from './Input'

describe('Input', () => {
  it('renders the given value and placeholder', () => {
    render(<Input value="hello" onChange={vi.fn()} placeholder="Search…" />)
    expect(screen.getByPlaceholderText('Search…')).toHaveValue('hello')
  })

  it('calls onChange with the new string value', () => {
    const onChange = vi.fn()
    render(<Input value="" onChange={onChange} placeholder="Search…" />)
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'abc' } })
    expect(onChange).toHaveBeenCalledWith('abc')
  })
})
