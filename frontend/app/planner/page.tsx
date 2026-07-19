'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { apiFetch } from '@/lib/api'
import ScheduleActionItemPanel from '@/app/components/ScheduleActionItemPanel'

type ActionItem = {
  id: string
  text: string
  direction: 'mine' | 'theirs'
  status: 'open' | 'done'
  due_date: string | null
  contact: { id: string; display_name: string | null; email_address: string | null } | null
  scheduled_calendar_event_id: string | null
  scheduled_start_time: string | null
  created_at: string
  updated_at: string
}

type Direction = 'all' | 'mine' | 'theirs'

function daysFromNow(dateStr: string): number {
  const due = new Date(dateStr + 'T00:00:00Z')
  const today = new Date()
  const startOfToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  return Math.round((due.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24))
}

export default function PlannerPage() {
  const router = useRouter()
  const [items, setItems] = useState<ActionItem[]>([])
  const [direction, setDirection] = useState<Direction>('all')
  const [includeDone, setIncludeDone] = useState(false)
  const [toggleError, setToggleError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams()
      if (direction !== 'all') params.set('direction', direction)
      if (includeDone) params.set('include_done', 'true')
      const query = params.toString()
      const response = await apiFetch(`/api/action-items${query ? `?${query}` : ''}`)
      if (response.status === 401) {
        router.push('/login')
        return
      }
      if (!response.ok) {
        setToggleError('Something went wrong loading your action items. Please try again.')
        return
      }
      setItems(await response.json())
    } catch {
      setToggleError('Something went wrong loading your action items. Please try again.')
    }
  }, [direction, includeDone, router])

  useEffect(() => {
    load()
  }, [load])

  async function toggleDone(item: ActionItem) {
    setToggleError(null)
    const nextStatus = item.status === 'open' ? 'done' : 'open'
    const response = await apiFetch(`/api/action-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    })
    if (!response.ok) {
      setToggleError('Something went wrong updating that item. Please try again.')
      return
    }
    await load()
  }

  const openItems = items.filter((item) => item.status === 'open')
  const doneItems = items.filter((item) => item.status === 'done')

  const overdue = openItems.filter((item) => item.due_date && daysFromNow(item.due_date) < 0)
  const dueThisWeek = openItems.filter((item) => item.due_date && daysFromNow(item.due_date) >= 0 && daysFromNow(item.due_date) <= 7)
  const later = openItems.filter((item) => item.due_date && daysFromNow(item.due_date) > 7)
  const noDueDate = openItems.filter((item) => !item.due_date)

  function renderItem(item: ActionItem) {
    return (
      <li key={item.id}>
        {item.text}
        {item.contact && ` — ${item.contact.display_name ?? item.contact.email_address}`}
        <button onClick={() => toggleDone(item)} className="ml-2 underline">
          {item.status === 'open' ? 'Mark done' : 'Reopen'}
        </button>
        {item.status === 'open' && (
          <ScheduleActionItemPanel
            itemId={item.id}
            scheduledCalendarEventId={item.scheduled_calendar_event_id}
            scheduledStartTime={item.scheduled_start_time}
            contact={item.contact}
            onScheduled={load}
          />
        )}
      </li>
    )
  }

  return (
    <div className="p-6">
      <div className="flex items-center gap-4">
        <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
          <option value="all">All</option>
          <option value="mine">Mine</option>
          <option value="theirs">Theirs</option>
        </select>
        <label>
          <input
            type="checkbox"
            checked={includeDone}
            onChange={(e) => setIncludeDone(e.target.checked)}
          />
          {' '}Show completed
        </label>
      </div>

      {toggleError && <p role="alert" className="mt-2 text-red-600">{toggleError}</p>}

      {items.length === 0 ? (
        <p className="mt-4">Nothing due.</p>
      ) : (
        <>
          {overdue.length > 0 && (
            <>
              <h2 className="mt-6 text-lg">Overdue</h2>
              <ul>{overdue.map(renderItem)}</ul>
            </>
          )}
          {dueThisWeek.length > 0 && (
            <>
              <h2 className="mt-6 text-lg">Due this week</h2>
              <ul>{dueThisWeek.map(renderItem)}</ul>
            </>
          )}
          {later.length > 0 && (
            <>
              <h2 className="mt-6 text-lg">Later</h2>
              <ul>{later.map(renderItem)}</ul>
            </>
          )}
          {noDueDate.length > 0 && (
            <>
              <h2 className="mt-6 text-lg">No due date</h2>
              <ul>{noDueDate.map(renderItem)}</ul>
            </>
          )}
          {includeDone && doneItems.length > 0 && (
            <>
              <h2 className="mt-6 text-lg">Completed</h2>
              <ul>{doneItems.map(renderItem)}</ul>
            </>
          )}
        </>
      )}
    </div>
  )
}
