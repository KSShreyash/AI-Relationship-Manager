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
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-8 text-center">
        <h1 className="text-lg font-semibold text-white">AI Relationship Manager</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Sign in to sync your contacts and follow-ups.
        </p>
        <button
          onClick={handleSignIn}
          className="mt-6 w-full rounded-md bg-emerald-500 px-6 py-3 font-medium text-neutral-950 transition hover:bg-emerald-400"
        >
          Sign in with Microsoft
        </button>
      </div>
    </main>
  )
}
