'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { apiBaseUrl } from '@/lib/api'
import { createClient } from '@/lib/supabase/client'
import { GRAPH_RESOURCE_SCOPES } from '@/lib/graph-scopes'

const GRAPH_TOKENS_TIMEOUT_MS = 30000

export default function CallbackPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function completeSignIn() {
      try {
        const supabase = createClient()
        const { data, error: sessionError } = await supabase.auth.getSession()

        if (sessionError || !data.session) {
          setError('Sign-in failed. Please try again.')
          return
        }

        const session = data.session as typeof data.session & {
          provider_token?: string
          provider_refresh_token?: string
        }

        if (!session.provider_token || !session.provider_refresh_token) {
          setError('Microsoft did not return Graph tokens. Please try again.')
          return
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), GRAPH_TOKENS_TIMEOUT_MS)

        let response: Response
        try {
          response = await fetch(
            `${apiBaseUrl()}/api/auth/graph-tokens`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${session.access_token}`,
              },
              body: JSON.stringify({
                provider_token: session.provider_token,
                provider_refresh_token: session.provider_refresh_token,
                expires_in: 3600,
                scopes: GRAPH_RESOURCE_SCOPES,
              }),
              signal: controller.signal,
            }
          )
        } finally {
          clearTimeout(timeout)
        }

        if (!response.ok) {
          setError('Could not save your Microsoft connection. Please try again.')
          return
        }

        router.push('/dashboard')
      } catch {
        setError('Could not save your Microsoft connection. Please try again.')
      }
    }

    completeSignIn()
  }, [router])

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4">
        <div className="text-center">
          <p role="alert" className="text-[var(--color-danger)]">{error}</p>
          <a href="/login" className="mt-4 inline-block text-sm text-[var(--color-accent)] hover:underline">
            Back to sign in
          </a>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg)] px-4">
      <p className="text-[var(--color-muted)]">Finishing sign-in…</p>
    </main>
  )
}
