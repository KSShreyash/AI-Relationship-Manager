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
      <li key={item.id} className="px-4 py-3 text-sm text-neutral-200">
        {item.text}
        {item.contact && (
          <span className="text-neutral-400"> — {item.contact.display_name ?? item.contact.email_address}</span>
        )}
        <button onClick={() => toggleDone(item)} className="ml-2 text-emerald-400 hover:underline">
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

  function renderGroup(title: string, groupItems: ActionItem[]) {
    if (groupItems.length === 0) return null
    return (
      <div className="mt-6">
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        <ul className="mt-2 divide-y divide-neutral-800 rounded-lg border border-neutral-800 bg-neutral-900">
          {groupItems.map(renderItem)}
        </ul>
      </div>
    )
  }

  return (
    <div className="p-8">
      <h1 className="text-xl font-semibold text-white">Planner</h1>

      <div className="mt-4 flex items-center gap-4">
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as Direction)}
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-emerald-500 focus:outline-none"
        >
          <option value="all">All</option>
          <option value="mine">Mine</option>
          <option value="theirs">Theirs</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={includeDone}
            onChange={(e) => setIncludeDone(e.target.checked)}
          />
          Show completed
        </label>
      </div>

      {toggleError && <p role="alert" className="mt-3 text-sm text-red-400">{toggleError}</p>}

      {items.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-400">Nothing due.</p>
      ) : (
        <>
          {renderGroup('Overdue', overdue)}
          {renderGroup('Due this week', dueThisWeek)}
          {renderGroup('Later', later)}
          {renderGroup('No due date', noDueDate)}
          {includeDone && renderGroup('Completed', doneItems)}
        </>
      )}
    </div>
  )
}
