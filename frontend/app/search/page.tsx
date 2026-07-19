'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { apiFetch } from '@/lib/api'

type Contact = {
  id: string
  display_name: string | null
  email_address: string | null
  notes: string | null
}

type ActionItem = {
  id: string
  text: string
  direction: 'mine' | 'theirs'
  status: 'open' | 'done'
  due_date: string | null
  contact: { id: string; display_name: string | null; email_address: string | null } | null
}

type Results = { contacts: Contact[]; action_items: ActionItem[] }

export default function SearchPage() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Results | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef(0)

  useEffect(() => {
    if (!query) {
      requestId.current++
      setResults(null)
      setError(null)
      return
    }

    const timer = setTimeout(() => {
      const thisRequest = ++requestId.current
      apiFetch(`/api/search?q=${encodeURIComponent(query)}`)
        .then(async (response) => {
          if (thisRequest !== requestId.current) return
          if (response.status === 401) {
            router.push('/login')
            return
          }
          if (!response.ok) {
            setError('Something went wrong searching. Please try again.')
            return
          }
          setError(null)
          setResults(await response.json())
        })
        .catch(() => {
          if (thisRequest === requestId.current) {
            setError('Something went wrong searching. Please try again.')
          }
        })
    }, 300)

    return () => clearTimeout(timer)
  }, [query, router])

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-white">Search</h1>

      <input
        type="text"
        placeholder="Search contacts and action items…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="mt-4 w-full max-w-md rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-emerald-500 focus:outline-none"
      />

      {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}

      {results === null ? (
        <p className="mt-4 text-sm text-neutral-400">Type to search your contacts and action items.</p>
      ) : (
        <>
          <h2 className="mt-6 text-sm font-semibold text-white">Contacts</h2>
          {results.contacts.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-400">No matching contacts.</p>
          ) : (
            <ul className="mt-2 divide-y divide-neutral-800 rounded-lg border border-neutral-800 bg-neutral-900">
              {results.contacts.map((contact) => (
                <li key={contact.id} className="px-4 py-3 text-sm text-neutral-200">
                  <a href={`/contacts/view?id=${contact.id}`} className="text-emerald-400 hover:underline">
                    {contact.display_name ?? contact.email_address}
                  </a>
                  {contact.notes && <span className="text-neutral-400"> — {contact.notes}</span>}
                </li>
              ))}
            </ul>
          )}

          <h2 className="mt-6 text-sm font-semibold text-white">Action Items</h2>
          {results.action_items.length === 0 ? (
            <p className="mt-2 text-sm text-neutral-400">No matching action items.</p>
          ) : (
            <ul className="mt-2 divide-y divide-neutral-800 rounded-lg border border-neutral-800 bg-neutral-900">
              {results.action_items.map((item) => (
                <li key={item.id} className="px-4 py-3 text-sm text-neutral-200">
                  {item.text}
                  {item.contact && (
                    <>
                      {' — '}
                      <a href={`/contacts/view?id=${item.contact.id}`} className="text-emerald-400 hover:underline">
                        {item.contact.display_name ?? item.contact.email_address}
                      </a>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
