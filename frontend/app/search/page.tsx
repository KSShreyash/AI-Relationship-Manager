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
    <div className="p-6">
      <input
        type="text"
        placeholder="Search contacts and action items…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="rounded border border-gray-300 px-3 py-2"
      />

      {error && <p role="alert" className="mt-2 text-red-600">{error}</p>}

      {results === null ? (
        <p className="mt-4">Type to search your contacts and action items.</p>
      ) : (
        <>
          <h2 className="mt-6 text-lg">Contacts</h2>
          {results.contacts.length === 0 ? (
            <p>No matching contacts.</p>
          ) : (
            <ul>
              {results.contacts.map((contact) => (
                <li key={contact.id}>
                  <a href={`/contacts/view?id=${contact.id}`}>
                    {contact.display_name ?? contact.email_address}
                  </a>
                  {contact.notes && ` — ${contact.notes}`}
                </li>
              ))}
            </ul>
          )}

          <h2 className="mt-6 text-lg">Action Items</h2>
          {results.action_items.length === 0 ? (
            <p>No matching action items.</p>
          ) : (
            <ul>
              {results.action_items.map((item) => (
                <li key={item.id}>
                  {item.text}
                  {item.contact && (
                    <>
                      {' — '}
                      <a href={`/contacts/view?id=${item.contact.id}`}>
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
