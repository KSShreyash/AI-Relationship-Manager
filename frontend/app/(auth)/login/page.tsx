'use client'

import { createClient } from '@/lib/supabase/client'
import { OAUTH_SCOPES } from '@/lib/graph-scopes'

export default function LoginPage() {
  async function handleSignIn() {
    const supabase = createClient()
    await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        scopes: OAUTH_SCOPES,
        redirectTo: `${window.location.origin}/callback`,
      },
    })
  }

  return (
    <main className="flex min-h-screen items-center justify-center">
      <button
        onClick={handleSignIn}
        className="rounded bg-blue-600 px-6 py-3 text-white"
      >
        Sign in with Microsoft
      </button>
    </main>
  )
}
