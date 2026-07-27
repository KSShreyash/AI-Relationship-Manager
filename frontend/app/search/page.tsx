'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Search as SearchIcon } from 'lucide-react'

import { apiFetch } from '@/lib/api'
import { getInitials } from '@/lib/getInitials'
import { Card } from '@/app/components/ui/Card'
import { EmptyState } from '@/app/components/ui/EmptyState'
import { Input } from '@/app/components/ui/Input'

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

function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index === -1) return text
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
        {text.slice(index, index + query.length)}
      </mark>
      {text.slice(index + query.length)}
    </>
  )
}

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
      <h1 className="text-xl font-bold text-[var(--color-fg)]">Search</h1>

      <Input
        value={query}
        onChange={setQuery}
        placeholder="Search contacts and action items…"
        aria-label="Search"
        className="mt-4 max-w-md"
      />

      {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{error}</p>}

      {results === null ? (
        <EmptyState
          icon={SearchIcon}
          title="Type to search your contacts and action items."
          className="mt-6"
        />
      ) : (
        <>
          <h2 className="mt-6 text-sm font-semibold text-[var(--color-fg)]">Contacts</h2>
          {results.contacts.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">No matching contacts.</p>
          ) : (
            <div className="mt-2 space-y-3">
              {results.contacts.map((contact) => (
                <Card key={contact.id} className="flex items-center gap-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-sm font-semibold text-[var(--color-accent)]">
                    {getInitials(contact.display_name, contact.email_address)}
                  </span>
                  <div className="min-w-0">
                    <a
                      href={`/contacts/view?id=${contact.id}`}
                      className="text-sm font-medium text-[var(--color-fg)] hover:underline"
                    >
                      {highlightMatch(contact.display_name ?? contact.email_address ?? '', query)}
                    </a>
                    {contact.notes && (
                      <p className="truncate text-xs text-[var(--color-muted)]">{contact.notes}</p>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}

          <h2 className="mt-6 text-sm font-semibold text-[var(--color-fg)]">Action Items</h2>
          {results.action_items.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">No matching action items.</p>
          ) : (
            <div className="mt-2 space-y-3">
              {results.action_items.map((item) => (
                <Card key={item.id} className="flex items-center justify-between gap-4">
                  <p className="min-w-0 truncate text-sm text-[var(--color-fg)]">
                    {highlightMatch(item.text, query)}
                  </p>
                  {item.contact && (
                    <a
                      href={`/contacts/view?id=${item.contact.id}`}
                      className="shrink-0 text-xs font-medium text-[var(--color-accent)] hover:underline"
                    >
                      {item.contact.display_name ?? item.contact.email_address}
                    </a>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
