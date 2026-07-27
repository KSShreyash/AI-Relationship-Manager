'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { apiFetch } from '@/lib/api'
import { getInitials } from '@/lib/getInitials'
import ScheduleActionItemPanel from '@/app/components/ScheduleActionItemPanel'
import { Badge, type BadgeVariant } from '@/app/components/ui/Badge'

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

  function renderItem(item: ActionItem, badgeVariant: BadgeVariant) {
    const isDone = item.status === 'done'
    return (
      <div key={item.id} className="flex items-center gap-3 px-4 py-3">
        <input
          type="checkbox"
          checked={isDone}
          onChange={() => toggleDone(item)}
          aria-label={isDone ? 'Reopen' : 'Mark done'}
          style={{ accentColor: 'var(--color-accent)' }}
          className="h-4 w-4 shrink-0 cursor-pointer rounded"
        />
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${isDone ? 'text-[var(--color-muted)] line-through' : 'text-[var(--color-fg)]'}`}>
            {item.text}
          </p>
          {item.contact && (
            <div className="mt-1 flex items-center gap-2">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)]/10 text-[10px] font-semibold text-[var(--color-accent)]">
                {getInitials(item.contact.display_name, item.contact.email_address)}
              </span>
              <span className="text-xs text-[var(--color-muted)]">
                {item.contact.display_name ?? item.contact.email_address}
              </span>
            </div>
          )}
        </div>
        {item.due_date && (
          <Badge variant={badgeVariant}>
            {new Date(item.due_date + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </Badge>
        )}
        {!isDone && (
          <ScheduleActionItemPanel
            itemId={item.id}
            scheduledCalendarEventId={item.scheduled_calendar_event_id}
            scheduledStartTime={item.scheduled_start_time}
            contact={item.contact}
            onScheduled={load}
          />
        )}
      </div>
    )
  }

  function renderGroup(title: string, groupItems: ActionItem[], borderColorVar: string, badgeVariant: BadgeVariant) {
    if (groupItems.length === 0) return null
    return (
      <div className="mt-6">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">{title}</h2>
        <div
          className="mt-2 divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] border-l-4"
          style={{ borderLeftColor: borderColorVar }}
        >
          {groupItems.map((item) => renderItem(item, badgeVariant))}
        </div>
      </div>
    )
  }

  return (
    <div className="p-8">
      <h1 className="text-xl font-bold text-[var(--color-fg)]">Planner</h1>

      <div className="mt-4 flex items-center gap-4">
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as Direction)}
          className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none"
        >
          <option value="all">All</option>
          <option value="mine">Mine</option>
          <option value="theirs">Theirs</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
          <input
            type="checkbox"
            checked={includeDone}
            onChange={(e) => setIncludeDone(e.target.checked)}
            style={{ accentColor: 'var(--color-accent)' }}
          />
          Show completed
        </label>
      </div>

      {toggleError && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{toggleError}</p>}

      {items.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-muted)]">Nothing due.</p>
      ) : (
        <>
          {renderGroup('Overdue', overdue, 'var(--color-danger)', 'danger')}
          {renderGroup('Due this week', dueThisWeek, 'var(--color-accent)', 'accent')}
          {renderGroup('Later', later, 'var(--color-border)', 'muted')}
          {renderGroup('No due date', noDueDate, 'var(--color-border)', 'muted')}
          {includeDone && renderGroup('Completed', doneItems, 'var(--color-border)', 'muted')}
        </>
      )}
    </div>
  )
}
