'use client'

import { useState } from 'react'

import { apiFetch } from '@/lib/api'

type Contact = { id: string; display_name: string | null; email_address: string | null }
type Slot = { start: string; end: string }

type ScheduleActionItemPanelProps = {
  itemId: string
  scheduledCalendarEventId: string | null
  scheduledStartTime: string | null
  contact: Contact | null
  onScheduled: () => void
}

export default function ScheduleActionItemPanel({
  itemId,
  scheduledCalendarEventId,
  scheduledStartTime,
  contact,
  onScheduled,
}: ScheduleActionItemPanelProps) {
  const [open, setOpen] = useState(false)
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [onlineMeeting, setOnlineMeeting] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!contact) return null

  if (scheduledCalendarEventId) {
    return (
      <span className="ml-2 text-neutral-400">
        Scheduled: {scheduledStartTime ? new Date(scheduledStartTime).toLocaleString() : 'yes'}
      </span>
    )
  }

  async function openPanel() {
    setOpen(true)
    setError(null)
    setSlots(null)
    const response = await apiFetch(`/api/action-items/${itemId}/schedule-suggestions`)
    if (!response.ok) {
      setError('Could not load suggested times. Please try again.')
      return
    }
    setSlots(await response.json())
  }

  async function confirm(slot: Slot) {
    setError(null)
    setSubmitting(true)
    const response = await apiFetch(`/api/action-items/${itemId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: slot.start, end: slot.end, online_meeting: onlineMeeting }),
    })
    if (!response.ok) {
      setError('Could not schedule that meeting. Please try again.')
      setSubmitting(false)
      return
    }
    setSubmitting(false)
    setOpen(false)
    onScheduled()
  }

  if (!open) {
    return (
      <button onClick={openPanel} className="ml-2 text-emerald-400 hover:underline">
        Schedule
      </button>
    )
  }

  return (
    <span className="ml-2 inline-block">
      {error && <p role="alert" className="text-red-400">{error}</p>}
      {slots === null ? (
        <span className="text-neutral-400">Loading suggestions…</span>
      ) : slots.length === 0 ? (
        <span className="text-neutral-400">No open slots found.</span>
      ) : (
        <>
          <label className="text-neutral-300">
            <input
              type="checkbox"
              checked={onlineMeeting}
              onChange={(e) => setOnlineMeeting(e.target.checked)}
              disabled={submitting}
            />
            {' '}Online meeting
          </label>
          <ul>
            {slots.map((slot) => (
              <li key={slot.start}>
                <button onClick={() => confirm(slot)} disabled={submitting} className="text-emerald-400 hover:underline disabled:opacity-50">
                  {new Date(slot.start).toLocaleString()}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </span>
  )
}
