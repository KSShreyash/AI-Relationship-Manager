import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Users } from 'lucide-react'

import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders the title', () => {
    render(<EmptyState icon={Users} title="No contacts yet" />)
    expect(screen.getByText('No contacts yet')).toBeInTheDocument()
  })

  it('renders the description when provided', () => {
    render(<EmptyState icon={Users} title="No contacts yet" description="Sync and extract to get started." />)
    expect(screen.getByText('Sync and extract to get started.')).toBeInTheDocument()
  })

  it('omits the description paragraph when not provided', () => {
    const { container } = render(<EmptyState icon={Users} title="No contacts yet" />)
    expect(container.querySelectorAll('p')).toHaveLength(1)
  })

  it('renders the action when provided', () => {
    render(<EmptyState icon={Users} title="No contacts yet" action={<button>Sync now</button>} />)
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument()
  })
})
