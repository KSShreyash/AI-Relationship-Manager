import { describe, expect, it, vi } from 'vitest'

vi.mock('@supabase/ssr', () => ({
  createBrowserClient: vi.fn(() => ({ mocked: true })),
}))

import { createBrowserClient } from '@supabase/ssr'
import { createClient } from './client'

describe('createClient', () => {
  it('calls createBrowserClient with the configured URL and anon key', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-123'

    createClient()

    expect(createBrowserClient).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key-123'
    )
  })
})
