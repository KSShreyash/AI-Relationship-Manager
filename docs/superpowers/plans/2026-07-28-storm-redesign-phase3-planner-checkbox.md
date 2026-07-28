# Storm Redesign Phase 3: Planner Tabs + Enterprise Checkbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Planner's dropdown+stacked-groups layout with a tab bar (Overdue/Today/Tomorrow/This week/Next week/No date/Completed), and replace the native browser checkbox on each item's done-toggle with a new styled enterprise `Checkbox` primitive.

**Architecture:** A new `Checkbox` UI primitive (Task 1) is built first, standalone and independently tested. Task 2 then rewrites `planner/page.tsx`'s bucketing/rendering logic to use tabs instead of stacked groups, and swaps in the new `Checkbox` for the done-toggle. The underlying fetch (`/api/action-items`), PATCH-on-toggle, and Schedule-panel integration are preserved — only the query string simplifies (now always requests `include_done=true`, since the Completed tab needs done items available at all times) and the client-side grouping logic changes from 4 stacked buckets to 7 mutually-exclusive, single-active-tab buckets.

**Tech Stack:** Next.js 16 (App Router), React, TypeScript, Tailwind CSS v4, `lucide-react`, Vitest + Testing Library.

## Global Constraints

- Zero backend/API/data-model changes.
- All colors via `var(--color-*)` CSS custom properties — never hardcoded hex or Tailwind palette classes.
- The bucketing logic must be exhaustive and mutually exclusive — every fetched item falls into exactly one of the 7 tabs:
  - `completed`: `status === 'done'` (checked first — a done item's due date no longer matters for bucketing)
  - `noDate`: `due_date === null` (and not done)
  - `overdue`: `daysFromNow(due_date) < 0`
  - `today`: `daysFromNow(due_date) === 0`
  - `tomorrow`: `daysFromNow(due_date) === 1`
  - `thisWeek`: `daysFromNow(due_date)` in `[2, 7]`
  - `nextWeek`: `daysFromNow(due_date) >= 8`
- Default active tab on load: `today`.
- The existing Mine/Theirs `direction` filter (a `<select>`, sent to the backend as a `direction` query param) is kept, just repositioned next to the tab bar — this is real, working functionality with no mockup equivalent, not something to remove.
- The `includeDone` state and its "Show completed" checkbox are removed entirely — Completed is now its own tab, and since a tab needs to show its count even when not active, the fetch must always request `include_done=true` (no conditional toggle).
- The existing `toggleDone` PATCH call, `ScheduleActionItemPanel` integration, and per-item contact-avatar rendering must not change behavior — only their surrounding markup/parent structure may change.
- Full spec: `docs/superpowers/specs/2026-07-28-storm-ui-redesign-design.md` (§6, §8).

---

### Task 1: Enterprise `Checkbox` UI primitive

**Files:**
- Create: `frontend/app/components/ui/Checkbox.tsx`
- Create: `frontend/app/components/ui/Checkbox.test.tsx`

**Interfaces:**
- Consumes: `Check` icon from `lucide-react` (already a project dependency, used elsewhere e.g. `ScheduleActionItemPanel`'s close button uses `X` from the same package).
- Produces: `Checkbox({ checked: boolean; onChange: () => void; 'aria-label': string })` — a named export. `onChange` takes no arguments (matches the one real call site's usage: `onChange={() => toggleDone(item)}`, which already ignores the DOM event). Renders a real `<input type="checkbox">` under the hood with the given `aria-label`, so `getByRole('checkbox', { name: ... })` queries keep working exactly as they do today against the native checkbox it replaces. Task 2 imports this as `import { Checkbox } from '@/app/components/ui/Checkbox'`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/components/ui/Checkbox.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Checkbox } from './Checkbox'

describe('Checkbox', () => {
  it('renders unchecked with the given aria-label', () => {
    render(<Checkbox checked={false} onChange={vi.fn()} aria-label="Mark done" />)
    expect(screen.getByRole('checkbox', { name: 'Mark done' })).not.toBeChecked()
  })

  it('renders checked', () => {
    render(<Checkbox checked={true} onChange={vi.fn()} aria-label="Reopen" />)
    expect(screen.getByRole('checkbox', { name: 'Reopen' })).toBeChecked()
  })

  it('calls onChange when clicked', () => {
    const onChange = vi.fn()
    render(<Checkbox checked={false} onChange={onChange} aria-label="Mark done" />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark done' }))
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run app/components/ui/Checkbox.test.tsx`
Expected: FAIL — `Cannot find module './Checkbox'`

- [ ] **Step 3: Write the implementation**

Create `frontend/app/components/ui/Checkbox.tsx`:

```tsx
import { Check } from 'lucide-react'

type CheckboxProps = {
  checked: boolean
  onChange: () => void
  'aria-label': string
}

export function Checkbox({ checked, onChange, 'aria-label': ariaLabel }: CheckboxProps) {
  return (
    <label className="group relative inline-flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={ariaLabel}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-[6px] border border-[var(--color-border)] bg-transparent transition peer-checked:border-[var(--color-accent)] peer-checked:bg-[var(--color-accent)] group-hover:border-[var(--color-accent)]"
      />
      <Check
        size={14}
        strokeWidth={3}
        aria-hidden="true"
        className="relative opacity-0 text-[var(--color-accent-fg)] transition peer-checked:opacity-100"
      />
    </label>
  )
}
```

(This is the exact `<label>` + `sr-only` input + `peer-checked:`-styled sibling technique already used for the online-meeting toggle in `frontend/app/components/ScheduleActionItemPanel.tsx` — wrapping the input in a `<label>` means a real browser click anywhere in the box toggles the input natively, with no extra click-forwarding logic needed. `sr-only` visually collapses the input to nothing while keeping it in the accessibility tree, so `getByRole('checkbox', ...)` still finds it directly.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run app/components/ui/Checkbox.test.tsx`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/ui/Checkbox.tsx frontend/app/components/ui/Checkbox.test.tsx
git commit -m "feat: add enterprise-style Checkbox UI primitive"
```

---

### Task 2: Planner — tab bar, due-date bucketing, and Checkbox integration

**Files:**
- Modify: `frontend/app/planner/page.tsx` (full-file replacement — the rendering model changes enough that a find/replace-block approach would be harder to follow than the complete new file)
- Modify: `frontend/app/planner/page.test.tsx` (full-file replacement, same reason — every existing test's assertions change because items are no longer all visible at once)

**Interfaces:**
- Consumes: `Checkbox` from Task 1 (`import { Checkbox } from '@/app/components/ui/Checkbox'`), exact props `{ checked, onChange, 'aria-label' }`.
- Produces: nothing consumed by a later phase — Planner is a leaf page in this redesign.

- [ ] **Step 1: Replace `frontend/app/planner/page.tsx` in full**

Replace the entire file content with:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { apiFetch } from '@/lib/api'
import { getInitials } from '@/lib/getInitials'
import ScheduleActionItemPanel from '@/app/components/ScheduleActionItemPanel'
import { Badge, type BadgeVariant } from '@/app/components/ui/Badge'
import { Checkbox } from '@/app/components/ui/Checkbox'

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
type TabKey = 'overdue' | 'today' | 'tomorrow' | 'thisWeek' | 'nextWeek' | 'noDate' | 'completed'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'thisWeek', label: 'This week' },
  { key: 'nextWeek', label: 'Next week' },
  { key: 'noDate', label: 'No date' },
  { key: 'completed', label: 'Completed' },
]

function daysFromNow(dateStr: string): number {
  const due = new Date(dateStr + 'T00:00:00Z')
  const today = new Date()
  const startOfToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  return Math.round((due.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24))
}

function bucketOf(item: ActionItem): TabKey {
  if (item.status === 'done') return 'completed'
  if (!item.due_date) return 'noDate'
  const days = daysFromNow(item.due_date)
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days <= 7) return 'thisWeek'
  return 'nextWeek'
}

function badgeVariantForBucket(bucket: TabKey): BadgeVariant {
  if (bucket === 'overdue') return 'danger'
  if (bucket === 'today' || bucket === 'tomorrow' || bucket === 'thisWeek') return 'accent'
  return 'muted'
}

export default function PlannerPage() {
  const router = useRouter()
  const [items, setItems] = useState<ActionItem[]>([])
  const [direction, setDirection] = useState<Direction>('all')
  const [activeTab, setActiveTab] = useState<TabKey>('today')
  const [toggleError, setToggleError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ include_done: 'true' })
      if (direction !== 'all') params.set('direction', direction)
      const response = await apiFetch(`/api/action-items?${params.toString()}`)
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
  }, [direction, router])

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

  const buckets: Record<TabKey, ActionItem[]> = {
    overdue: [],
    today: [],
    tomorrow: [],
    thisWeek: [],
    nextWeek: [],
    noDate: [],
    completed: [],
  }
  for (const item of items) {
    buckets[bucketOf(item)].push(item)
  }

  function renderItem(item: ActionItem) {
    const isDone = item.status === 'done'
    const badgeVariant = badgeVariantForBucket(bucketOf(item))
    return (
      <div key={item.id} className="flex items-center gap-3 px-4 py-3">
        <Checkbox
          checked={isDone}
          onChange={() => toggleDone(item)}
          aria-label={isDone ? 'Reopen' : 'Mark done'}
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

  const activeItems = buckets[activeTab]

  return (
    <div className="p-8">
      <h1 className="text-xl font-bold text-[var(--color-fg)]">Planner</h1>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div className="flex flex-wrap gap-2">
          {TABS.map((tab) => {
            const active = activeTab === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                aria-pressed={active}
                className={`flex items-center gap-2 rounded-[var(--radius-card)] px-3 py-1.5 text-sm font-medium transition ${
                  active
                    ? 'bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
                    : 'border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                {tab.label}
                <span
                  className={`rounded-full px-1.5 py-0.5 text-xs ${
                    active ? 'bg-black/15' : 'bg-[var(--color-surface)] text-[var(--color-muted)]'
                  }`}
                >
                  {buckets[tab.key].length}
                </span>
              </button>
            )
          })}
        </div>

        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as Direction)}
          className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none"
        >
          <option value="all">All</option>
          <option value="mine">Mine</option>
          <option value="theirs">Theirs</option>
        </select>
      </div>

      {toggleError && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{toggleError}</p>}

      {items.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-muted)]">Nothing due.</p>
      ) : (
        <div className="mt-4 divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          {activeItems.length === 0 ? (
            <p className="px-4 py-6 text-sm text-[var(--color-muted)]">Nothing here.</p>
          ) : (
            activeItems.map((item) => renderItem(item))
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Replace `frontend/app/planner/page.test.tsx` in full**

Replace the entire file content with:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, pushMock, routerMock } = vi.hoisted(() => {
  const pushMock = vi.fn()
  return { apiFetchMock: vi.fn(), pushMock, routerMock: { push: pushMock } }
})

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }))

import PlannerPage from './page'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

const TODAY = new Date('2026-07-17T12:00:00Z')

const ITEMS = [
  { id: '1', text: 'Overdue task', direction: 'mine', status: 'open', due_date: '2026-07-10', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
  { id: '2', text: 'Due this week', direction: 'theirs', status: 'open', due_date: '2026-07-19', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
  { id: '3', text: 'No due date task', direction: 'mine', status: 'open', due_date: null, contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
]

describe('PlannerPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(TODAY)
    apiFetchMock.mockReset()
    pushMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows an inline error instead of failing silently when the fetch throws', async () => {
    apiFetchMock.mockRejectedValue(new Error('network error'))

    render(<PlannerPage />)

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
  })

  it('redirects to login on a 401 (no session)', async () => {
    apiFetchMock.mockResolvedValue(new Response(null, { status: 401 }))

    render(<PlannerPage />)

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/login'))
  })

  it('always fetches with include_done=true so the Completed tab has data available', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(ITEMS))

    render(<PlannerPage />)

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/action-items?include_done=true'))
  })

  it('buckets items into tabs by due date and shows each tab\'s count', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(ITEMS))

    render(<PlannerPage />)

    await waitFor(() => expect(screen.getByRole('button', { name: /^overdue/i })).toHaveTextContent('1'))
    expect(screen.getByRole('button', { name: /^this week/i })).toHaveTextContent('1')
    expect(screen.getByRole('button', { name: /^no date/i })).toHaveTextContent('1')
    expect(screen.getByRole('button', { name: /^today/i })).toHaveTextContent('0')

    // Default tab is "Today", which has no items yet.
    expect(screen.getByText('Nothing here.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^overdue/i }))
    expect(screen.getByText('Overdue task')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^this week/i }))
    expect(screen.getByText('Due this week')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^no date/i }))
    expect(screen.getByText('No due date task')).toBeInTheDocument()
  })

  it('marks an item done and refetches the list', async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...ITEMS[0], status: 'done' }))
      }
      return Promise.resolve(jsonResponse(ITEMS))
    })

    render(<PlannerPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^overdue/i })).toHaveTextContent('1'))
    fireEvent.click(screen.getByRole('button', { name: /^overdue/i }))
    expect(screen.getByText('Overdue task')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: /mark done/i }))

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/action-items/1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      })
    )
  })

  it('shows an inline error and leaves the item unchanged when the PATCH fails', async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(new Response(null, { status: 500 }))
      }
      return Promise.resolve(jsonResponse(ITEMS))
    })

    render(<PlannerPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^overdue/i })).toHaveTextContent('1'))
    fireEvent.click(screen.getByRole('button', { name: /^overdue/i }))
    expect(screen.getByText('Overdue task')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: /mark done/i }))

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
    expect(screen.getByText('Overdue task')).toBeInTheDocument()
  })

  it('shows the Next week tab, the Completed tab, and a contact avatar/name when present', async () => {
    const EXTENDED_ITEMS = [
      { id: '4', text: 'Later task', direction: 'mine', status: 'open', due_date: '2026-08-01', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
      { id: '5', text: 'Done task', direction: 'mine', status: 'done', due_date: '2026-07-15', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
      { id: '6', text: 'Contact task', direction: 'theirs', status: 'open', due_date: null, contact: { id: 'c1', display_name: 'Dana', email_address: 'dana@example.com' }, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
    ]
    apiFetchMock.mockImplementation(() => Promise.resolve(jsonResponse(EXTENDED_ITEMS)))

    render(<PlannerPage />)
    await waitFor(() => expect(screen.getByRole('button', { name: /^next week/i })).toHaveTextContent('1'))

    fireEvent.click(screen.getByRole('button', { name: /^next week/i }))
    expect(screen.getByText('Later task')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^completed/i }))
    expect(screen.getByText('Done task')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^no date/i }))
    expect(screen.getByText('Contact task')).toBeInTheDocument()
    expect(screen.getByText(/Dana/)).toBeInTheDocument()
    expect(screen.getByText('D')).toBeInTheDocument()
  })

  it('shows a Schedule control on open items with a contact and hides it once scheduled', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse([
      {
        id: '10', text: 'Call Gina', direction: 'mine', status: 'open', due_date: null,
        contact: { id: 'c1', display_name: 'Gina', email_address: 'gina@example.com' },
        scheduled_calendar_event_id: null, scheduled_start_time: null,
        created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
      },
      {
        id: '11', text: 'Already booked', direction: 'mine', status: 'open', due_date: null,
        contact: { id: 'c2', display_name: 'Bob', email_address: 'bob@example.com' },
        scheduled_calendar_event_id: 'evt-1', scheduled_start_time: '2026-07-22T14:00:00Z',
        created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
      },
    ]))

    render(<PlannerPage />)

    await waitFor(() => expect(screen.getByRole('button', { name: /^no date/i })).toHaveTextContent('2'))
    fireEvent.click(screen.getByRole('button', { name: /^no date/i }))

    expect(screen.getByText(/Call Gina/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^schedule$/i })).toBeInTheDocument()
    expect(screen.getByText(/scheduled:/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run the Planner test file to verify everything passes**

Run: `cd frontend && npx vitest run app/planner/page.test.tsx`
Expected: PASS (9/9). Walk through why each bucket assertion holds, given `TODAY = 2026-07-17`:
- `ITEMS[0]` due `2026-07-10` → `daysFromNow = -7` → `overdue`
- `ITEMS[1]` due `2026-07-19` → `daysFromNow = 2` → `thisWeek` (`[2,7]`)
- `ITEMS[2]` due `null` → `noDate`
- `EXTENDED_ITEMS[0]` due `2026-08-01` → `daysFromNow = 15` → `nextWeek` (`>= 8`)
- `EXTENDED_ITEMS[1]` `status: 'done'` → `completed`, regardless of its `due_date` being in the past
- `EXTENDED_ITEMS[2]` due `null`, `status: 'open'` → `noDate`

- [ ] **Step 4: Run the full suite to confirm no other regressions**

Run: `cd frontend && npx vitest run`
Expected: all test files pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/planner/page.tsx frontend/app/planner/page.test.tsx
git commit -m "feat: replace Planner's stacked groups with a due-date tab bar and enterprise checkboxes"
```

---

## Phase 3 Verification

- [ ] Run the full suite once more: `cd frontend && npx vitest run`
- [ ] Run the project's lint command in `frontend/` and confirm zero new errors.
- [ ] Start the dev server and visually confirm: Planner shows a row of tabs with counts (Overdue/Today/Tomorrow/This week/Next week/No date/Completed), clicking a tab shows only that bucket's items, the Mine/Theirs filter still works, marking an item done moves it to the Completed tab on next load, and each item's done-toggle is now the styled square checkbox (border → accent-filled with a checkmark when checked) instead of the plain browser checkbox.
