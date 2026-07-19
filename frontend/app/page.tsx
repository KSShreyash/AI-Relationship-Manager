'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { createClient } from '@/lib/supabase/client'

export default function Home() {
  const router = useRouter()

  useEffect(() => {
    async function redirect() {
      const supabase = createClient()
      const { data } = await supabase.auth.getSession()
      router.push(data.session ? '/dashboard' : '/login')
    }

    redirect()
  }, [router])

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
      <p className="text-neutral-400">Redirecting…</p>
    </main>
  )
}
