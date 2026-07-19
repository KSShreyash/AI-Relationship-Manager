'use client'

import { usePathname, useRouter } from 'next/navigation'

import { createClient } from '@/lib/supabase/client'

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/contacts', label: 'Contacts' },
  { href: '/planner', label: 'Planner' },
  { href: '/search', label: 'Search' },
]

const CHROME_HIDDEN_PATHS = new Set(['/', '/login', '/callback'])

export default function NavBar() {
  const pathname = usePathname()
  const router = useRouter()

  if (CHROME_HIDDEN_PATHS.has(pathname)) return null

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <nav className="flex w-56 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950 px-3 py-6">
      <div className="mb-8 px-3 text-sm font-semibold tracking-wide text-white">
        AI Relationship Manager
      </div>

      <div className="flex flex-1 flex-col gap-1">
        {NAV_LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`)
          return (
            <a
              key={link.href}
              href={link.href}
              className={`rounded-md px-3 py-2 text-sm transition ${
                active
                  ? 'bg-neutral-800 text-white'
                  : 'text-neutral-400 hover:bg-neutral-900 hover:text-white'
              }`}
            >
              {link.label}
            </a>
          )
        })}
      </div>

      <button
        onClick={handleSignOut}
        className="mt-6 rounded-md px-3 py-2 text-left text-sm text-neutral-400 transition hover:bg-neutral-900 hover:text-white"
      >
        Sign out
      </button>
    </nav>
  )
}
