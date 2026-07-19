'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { createClient } from '@/lib/supabase/client'
import { GRAPH_RESOURCE_SCOPES } from '@/lib/graph-scopes'

export default function CallbackPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function completeSignIn() {
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

      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_BASE_URL}/api/auth/graph-tokens`,
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
        }
      )

      if (!response.ok) {
        setError('Could not save your Microsoft connection. Please try again.')
        return
      }

      router.push('/dashboard')
    }

    completeSignIn()
  }, [router])

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
        <p role="alert" className="text-red-400">{error}</p>
      </main>
    )
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
      <p className="text-neutral-400">Finishing sign-in…</p>
    </main>
  )
}
