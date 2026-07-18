'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

import { apiFetch } from '@/lib/api'
import ScheduleActionItemPanel from '@/app/components/ScheduleActionItemPanel'

type ContactDetail = {
  id: string
  email_address: string | null
  display_name: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

type ActionItem = {
  id: string
  text: string
  direction: 'mine' | 'theirs'
  status: 'open' | 'done'
  due_date: string | null
  source_type: string
  scheduled_calendar_event_id: string | null
  scheduled_start_time: string | null
  created_at: string
  updated_at: string
}

type State =
  | { state: 'loading' }
  | { state: 'not_found' }
  | { state: 'error' }
  | { state: 'ready'; contact: ContactDetail; actionItems: ActionItem[] }

export default function ContactProfilePage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <ContactProfileContent />
    </Suspense>
  )
}

function ContactProfileContent() {
  const searchParams = useSearchParams()
  const id = searchParams.get('id')
  const [state, setState] = useState<State>({ state: 'loading' })

  const load = useCallback(async () => {
    if (!id) {
      setState({ state: 'not_found' })
      return
    }

    const contactResponse = await apiFetch(`/api/contacts/${id}`)
    if (contactResponse.status === 404) {
      setState({ state: 'not_found' })
      return
    }
    if (!contactResponse.ok) {
      setState({ state: 'error' })
      return
    }
    const contact = await contactResponse.json()

    const actionItemsResponse = await apiFetch(`/api/contacts/${id}/action-items`)
    if (!actionItemsResponse.ok) {
      setState({ state: 'error' })
      return
    }
    const actionItems = await actionItemsResponse.json()

    setState({ state: 'ready', contact, actionItems })
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  if (state.state === 'loading') return <p>Loading…</p>
  if (state.state === 'not_found') return <p>Contact not found.</p>
  if (state.state === 'error') return <p role="alert">Something went wrong loading this contact.</p>

  const { contact, actionItems } = state
  const openItems = actionItems.filter((item) => item.status === 'open')
  const doneItems = actionItems.filter((item) => item.status === 'done')

  return (
    <div className="p-6">
      <h1 className="text-xl">{contact.display_name ?? contact.email_address}</h1>
      {contact.email_address && <p>{contact.email_address}</p>}
      <p className="mt-4">{contact.notes ?? 'No notes yet.'}</p>

      <h2 className="mt-6 text-lg">Open</h2>
      {openItems.length === 0 ? (
        <p>Nothing open.</p>
      ) : (
        <ul>
          {openItems.map((item) => (
            <li key={item.id}>
              {item.text}
              <ScheduleActionItemPanel
                itemId={item.id}
                scheduledCalendarEventId={item.scheduled_calendar_event_id}
                scheduledStartTime={item.scheduled_start_time}
                contact={contact}
                onScheduled={load}
              />
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-6 text-lg">Done</h2>
      {doneItems.length === 0 ? (
        <p>Nothing done yet.</p>
      ) : (
        <ul>
          {doneItems.map((item) => (
            <li key={item.id}>{item.text}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
