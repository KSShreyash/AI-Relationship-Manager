'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { apiFetch } from '@/lib/api'

type Contact = {
  id: string
  email_address: string | null
  display_name: string | null
  open_action_item_count: number
  updated_at: string
}

export default function ContactsPage() {
  const router = useRouter()
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [error, setError] = useState(false)
  const [search, setSearch] = useState('')
  const requestId = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      const thisRequest = ++requestId.current
      const query = search ? `?q=${encodeURIComponent(search)}` : ''
      apiFetch(`/api/contacts${query}`)
        .then(async (response) => {
          if (response.status === 401) {
            router.push('/login')
            return
          }
          if (!response.ok) {
            if (thisRequest === requestId.current) setError(true)
            return
          }
          const body = await response.json()
          if (thisRequest === requestId.current) {
            setError(false)
            setContacts(body)
          }
        })
        .catch(() => {
          if (thisRequest === requestId.current) setError(true)
        })
    }, 300)

    return () => clearTimeout(timer)
  }, [search, router])

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-white">Contacts</h1>

      <input
        type="text"
        placeholder="Search contacts…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mt-4 w-full max-w-sm rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-emerald-500 focus:outline-none"
      />

      {error && (
        <p role="alert" className="mt-4 text-sm text-red-400">
          Something went wrong loading your contacts.
        </p>
      )}

      {contacts === null ? (
        error ? null : <p className="mt-4 text-sm text-neutral-400">Loading…</p>
      ) : contacts.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-400">No contacts yet — sync and extract to get started.</p>
      ) : (
        <ul className="mt-4 divide-y divide-neutral-800 rounded-lg border border-neutral-800 bg-neutral-900">
          {contacts.map((contact) => (
            <li key={contact.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <a href={`/contacts/view?id=${contact.id}`} className="text-emerald-400 hover:underline">
                {contact.display_name ?? contact.email_address}
              </a>
              <span className="text-neutral-400">
                {contact.open_action_item_count} open action item
                {contact.open_action_item_count === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
