'use client'

import { useEffect, useRef, useState } from 'react'

import { apiFetch } from '@/lib/api'

type Contact = {
  id: string
  email_address: string | null
  display_name: string | null
  open_action_item_count: number
  updated_at: string
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [search, setSearch] = useState('')
  const requestId = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      const thisRequest = ++requestId.current
      const query = search ? `?q=${encodeURIComponent(search)}` : ''
      apiFetch(`/api/contacts${query}`).then(async (response) => {
        if (!response.ok) return
        const body = await response.json()
        if (thisRequest === requestId.current) {
          setContacts(body)
        }
      })
    }, 300)

    return () => clearTimeout(timer)
  }, [search])

  return (
    <div className="p-6">
      <input
        type="text"
        placeholder="Search contacts…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="rounded border border-gray-300 px-3 py-2"
      />

      {contacts === null ? (
        <p className="mt-4">Loading…</p>
      ) : contacts.length === 0 ? (
        <p className="mt-4">No contacts yet — sync and extract to get started.</p>
      ) : (
        <ul className="mt-4">
          {contacts.map((contact) => (
            <li key={contact.id}>
              <a href={`/contacts/${contact.id}`}>
                {contact.display_name ?? contact.email_address}
              </a>
              {' — '}
              {contact.open_action_item_count} open action item
              {contact.open_action_item_count === 1 ? '' : 's'}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
