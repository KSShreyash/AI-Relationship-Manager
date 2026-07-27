# UI Redesign Phase 4: Planner + Scheduling Popover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `ScheduleActionItemPanel` as a real floating popover (replacing the inline expanding list), and redesign the Planner page's item rows, groups, and controls on top of it and the Phase 1-3 design system — zero backend/API/data-model changes.

**Architecture:** `ScheduleActionItemPanel` becomes a self-contained anchored popover (plain `position: relative`/`absolute` positioning + a single `framer-motion` entrance animation, no new dependency) with a slot-chip grid and a toggle-switch built from a visually-hidden native checkbox. Planner's item rows get a native (but accent-tinted) checkbox for the done-toggle, a `getInitials`-based contact avatar, and a `Badge`-based due-date pill; each group container gets a status-colored left border. Both stay plain elements (no `Button`/`Card` dependency) — see Global Constraints for why.

**Tech Stack:** Next.js 16 (App Router, static export), React 19, TypeScript, Tailwind CSS v4, Vitest + Testing Library, `framer-motion`, `lucide-react`, `clsx` (all already installed).

## Global Constraints

- No backend changes. The only fetches are the pre-existing `/api/action-items`, `/api/action-items/{id}`, `/api/action-items/{id}/schedule-suggestions`, `/api/action-items/{id}/schedule`.
- **Correction to the original design spec:** the spec's Planner section said `source_type` (email/calendar/manual) could be shown as a badge on each item. This is wrong — `backend/app/api/v1/action_items.py`'s `_serialize` function (used by `GET /api/action-items`, Planner's endpoint) does **not** include `source_type` in its response, unlike the contacts endpoint's serializer. Do not build a source_type badge in this phase; there is nothing to bind it to without a backend change.
- **No `Button`/`Card` widening this phase, and neither component is used by the two files this phase touches.** The final Phase 3 review speculated `Button` would need `aria-pressed`/broader ARIA passthrough for "Planner's status filters" and "the scheduling popover." Concretely designing this phase found neither claim holds: Planner's direction filter stays a native `<select>` and the "Show completed"/per-item done-toggle stay native `<input type="checkbox">` (all lightly restyled with tokens, no widget-type change beyond the item-level checkbox described below) — no segmented Button control is being built. The popover's trigger, close button, and slot chips all stay plain `<button>` elements with `aria-expanded`/`aria-label` set directly, matching the precedent set by Phase 3 Task 5 (which deliberately kept this component free of `Button`/`Card` to avoid style-override friction). Do not add unused props to `Button` "for later" — extend it only when a concrete consumer in a later phase needs it.
- Color tokens already defined in `frontend/app/globals.css` (Phases 1-3): `--color-bg`, `--color-bg-alt`, `--color-surface`, `--color-border`, `--color-accent`, `--color-accent-fg`, `--color-muted`, `--color-fg`, `--radius-card`, `--color-danger`, `--color-danger-border`, `--color-danger-surface`, `--color-warning`. No new tokens needed this phase.
- No hardcoded hex/Tailwind-palette colors in any component — everything through `var(--color-*)`, either via Tailwind arbitrary-value classes or (for dynamically-chosen colors like a group's left-border color) an inline `style` prop set to the literal string `'var(--color-*)'` — never construct a Tailwind arbitrary-value class name from a variable at runtime (Tailwind's JIT scanner only detects statically-written class strings).
- Motion: `framer-motion`, ~200ms ease-out, no bounce/spring overshoot. The popover uses an **entrance-only** animation (`initial`/`animate`, no `AnimatePresence`/`exit`) — closing is an instant unmount. This is a deliberate simplification: `AnimatePresence` would require either `waitFor`-based test assertions for its exit lifecycle or a fixed delay, for a purely cosmetic close transition the spec doesn't explicitly require ("fade + scale-in" describes the open transition).
- Checkbox tinting: use the native CSS `accent-color` property (via an inline `style={{ accentColor: 'var(--color-accent)' }}`) rather than hand-rolling a custom checkbox — preserves native `checkbox` semantics/keyboard behavior for free.
- Every existing test in `frontend/app/components/ScheduleActionItemPanel.test.tsx` and `frontend/app/planner/page.test.tsx` must keep passing — updated only where a deliberate, spec-driven change requires it (documented per-task below), never loosened.
- Follow `frontend/AGENTS.md`: `frontend/app/planner/page.test.tsx` uses `vi.useFakeTimers({ toFake: ['Date'] })` (scoped to `Date` only) combined with `fireEvent` — this is correct and must be preserved; do not introduce `userEvent` into it.

---

### Task 1: Rebuild `ScheduleActionItemPanel` as a floating popover

**Files:**
- Modify: `frontend/app/components/ScheduleActionItemPanel.tsx`
- Modify: `frontend/app/components/ScheduleActionItemPanel.test.tsx`

**Interfaces:**
- Consumes: nothing new (`apiFetch` from `@/lib/api`, `motion` from `framer-motion`, `X` icon from `lucide-react`).
- Produces: same default export, same prop signature (`itemId`, `scheduledCalendarEventId`, `scheduledStartTime`, `contact`, `onScheduled`) — no interface change for consumers. Task 2 (Planner) consumes this unchanged.

- [ ] **Step 1: Write the new/changed tests**

Replace the full contents of `frontend/app/components/ScheduleActionItemPanel.test.tsx` with:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))

import ScheduleActionItemPanel from './ScheduleActionItemPanel'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

const CONTACT = { id: 'c1', display_name: 'Gina', email_address: 'gina@example.com' }

describe('ScheduleActionItemPanel', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('renders nothing when there is no linked contact', () => {
    const { container } = render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId={null} scheduledStartTime={null}
        contact={null} onScheduled={vi.fn()}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('shows a scheduled indicator instead of a button when already scheduled', () => {
    render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId="evt-1" scheduledStartTime="2026-07-20T14:00:00Z"
        contact={CONTACT} onScheduled={vi.fn()}
      />
    )

    expect(screen.getByText(/scheduled/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /schedule/i })).not.toBeInTheDocument()
  })

  it('fetches and shows suggested slots when Schedule is clicked', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse([{ start: '2026-07-20T14:00:00Z', end: '2026-07-20T14:30:00Z' }])
    )

    render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId={null} scheduledStartTime={null}
        contact={CONTACT} onScheduled={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /schedule/i }))

    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledWith('/api/action-items/item-1/schedule-suggestions'))
    expect(await screen.findByRole('button', { name: /2026/i })).toBeInTheDocument()
  })

  it('confirms a slot and calls onScheduled on success', async () => {
    const onScheduled = vi.fn()
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(jsonResponse({ status: 'ok' }))
      return Promise.resolve(jsonResponse([{ start: '2026-07-20T14:00:00Z', end: '2026-07-20T14:30:00Z' }]))
    })

    render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId={null} scheduledStartTime={null}
        contact={CONTACT} onScheduled={onScheduled}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /schedule/i }))
    const slotButton = await screen.findByRole('button', { name: /2026/i })
    fireEvent.click(slotButton)

    await waitFor(() => expect(onScheduled).toHaveBeenCalled())
    expect(apiFetchMock).toHaveBeenCalledWith('/api/action-items/item-1/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: '2026-07-20T14:00:00Z', end: '2026-07-20T14:30:00Z', online_meeting: true }),
    })
  })

  it('disables the slot buttons while a schedule request is in flight', async () => {
    let resolvePost: (value: Response) => void = () => {}
    const postPromise = new Promise<Response>((resolve) => {
      resolvePost = resolve
    })
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return postPromise
      return Promise.resolve(jsonResponse([{ start: '2026-07-20T14:00:00Z', end: '2026-07-20T14:30:00Z' }]))
    })

    render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId={null} scheduledStartTime={null}
        contact={CONTACT} onScheduled={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /schedule/i }))
    const slotButton = await screen.findByRole('button', { name: /2026/i })
    fireEvent.click(slotButton)

    await waitFor(() => expect(slotButton).toBeDisabled())

    resolvePost(jsonResponse({ status: 'ok' }))
  })

  it('shows an inline error and keeps the panel open when confirming fails', async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve(new Response(null, { status: 502 }))
      return Promise.resolve(jsonResponse([{ start: '2026-07-20T14:00:00Z', end: '2026-07-20T14:30:00Z' }]))
    })

    render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId={null} scheduledStartTime={null}
        contact={CONTACT} onScheduled={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /schedule/i }))
    const slotButton = await screen.findByRole('button', { name: /2026/i })
    fireEvent.click(slotButton)

    await waitFor(() => expect(screen.getByText(/could not schedule/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /2026/i })).toBeInTheDocument()
  })

  it('reflects the open state via aria-expanded on the trigger', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse([{ start: '2026-07-20T14:00:00Z', end: '2026-07-20T14:30:00Z' }])
    )

    render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId={null} scheduledStartTime={null}
        contact={CONTACT} onScheduled={vi.fn()}
      />
    )
    const trigger = screen.getByRole('button', { name: /schedule/i })
    expect(trigger).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(trigger)

    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'))
  })

  it('closes the panel when the close button is clicked', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse([{ start: '2026-07-20T14:00:00Z', end: '2026-07-20T14:30:00Z' }])
    )

    render(
      <ScheduleActionItemPanel
        itemId="item-1" scheduledCalendarEventId={null} scheduledStartTime={null}
        contact={CONTACT} onScheduled={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /schedule/i }))
    await screen.findByRole('button', { name: /2026/i })

    fireEvent.click(screen.getByRole('button', { name: /close/i }))

    expect(screen.queryByRole('button', { name: /2026/i })).not.toBeInTheDocument()
  })
})
```

Note what changed from the original file and why: the first 6 tests are verbatim unchanged (same behavior, same assertions) — the trigger button's text/role, the slot buttons, the error/disabled/success paths are all identical. Two tests were added for genuinely new behavior this task introduces: `aria-expanded` on the trigger, and the new close button.

- [ ] **Step 2: Run tests to verify the two new ones fail**

Run: `npm --prefix frontend test -- ScheduleActionItemPanel.test.tsx`
Expected: the first 6 tests still PASS against the current component (their behavior isn't changing); "reflects the open state via aria-expanded on the trigger" and "closes the panel when the close button is clicked" FAIL (no `aria-expanded` attribute and no close button exist yet).

- [ ] **Step 3: Implement the popover**

Replace the full contents of `frontend/app/components/ScheduleActionItemPanel.tsx` with:

```tsx
'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { X } from 'lucide-react'

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
      <span className="ml-2 text-[var(--color-muted)]">
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

  function closePanel() {
    setOpen(false)
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

  return (
    <span className="relative ml-2 inline-block">
      <button
        onClick={open ? closePanel : openPanel}
        aria-expanded={open}
        className="text-sm font-medium text-[var(--color-accent)] hover:underline"
      >
        Schedule
      </button>

      {open && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          className="absolute left-0 top-full z-10 mt-2 w-72 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-[var(--color-fg)]">Pick a time</span>
            <button
              onClick={closePanel}
              aria-label="Close"
              className="text-[var(--color-muted)] hover:text-[var(--color-fg)]"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          {error && <p role="alert" className="mt-2 text-sm text-[var(--color-danger)]">{error}</p>}

          {slots === null ? (
            <p className="mt-3 text-sm text-[var(--color-muted)]">Loading suggestions…</p>
          ) : slots.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--color-muted)]">No open slots found.</p>
          ) : (
            <>
              <label className="mt-3 flex items-center justify-between text-sm text-[var(--color-fg)]">
                Online meeting
                <span className="relative inline-flex h-5 w-9 shrink-0">
                  <input
                    type="checkbox"
                    checked={onlineMeeting}
                    onChange={(e) => setOnlineMeeting(e.target.checked)}
                    disabled={submitting}
                    className="peer sr-only"
                  />
                  <span className="absolute inset-0 rounded-full bg-[var(--color-border)] transition-colors peer-checked:bg-[var(--color-accent)]" />
                  <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-[var(--color-fg)] transition-transform peer-checked:translate-x-4" />
                </span>
              </label>

              <div className={`mt-3 grid grid-cols-2 gap-2 ${submitting ? 'opacity-50' : ''}`}>
                {slots.map((slot) => (
                  <button
                    key={slot.start}
                    onClick={() => confirm(slot)}
                    disabled={submitting}
                    className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-2 py-2 text-xs font-medium text-[var(--color-fg)] transition hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 disabled:pointer-events-none"
                  >
                    {new Date(slot.start).toLocaleString()}
                  </button>
                ))}
              </div>
            </>
          )}
        </motion.div>
      )}
    </span>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix frontend test -- ScheduleActionItemPanel.test.tsx`
Expected: PASS (8/8 tests)

- [ ] **Step 5: Run the full suite and the build**

Run:
```bash
npm --prefix frontend test
npm --prefix frontend run build
```
Expected: all tests pass, static export succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/components/ScheduleActionItemPanel.tsx frontend/app/components/ScheduleActionItemPanel.test.tsx
git commit -m "feat: rebuild scheduling panel as a floating popover"
```

---

### Task 2: Redesign the Planner page

**Files:**
- Modify: `frontend/app/planner/page.tsx`
- Modify: `frontend/app/planner/page.test.tsx`

**Interfaces:**
- Consumes: `getInitials` from `@/lib/getInitials` (built in Phase 3), `Badge`/`BadgeVariant` from `@/app/components/ui/Badge` (built in Phase 3), the popover-rebuilt `ScheduleActionItemPanel` (Task 1).
- Produces: no interface changes — same default export, same fetch calls, same `toggleDone`/`load` logic.

- [ ] **Step 1: Write the changed tests**

Replace the full contents of `frontend/app/planner/page.test.tsx` with:

```tsx
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

  it('groups open items into Overdue, Due this week, and No due date sections', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse(ITEMS))

    render(<PlannerPage />)

    await waitFor(() => expect(screen.getByText('Overdue task')).toBeInTheDocument())
    expect(screen.getByText('Due this week', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByText('No due date task')).toBeInTheDocument()
  })

  it('refetches with include_done=true when the show-completed toggle is checked', async () => {
    apiFetchMock.mockImplementation(() => Promise.resolve(jsonResponse(ITEMS)))

    render(<PlannerPage />)
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('checkbox', { name: /show completed/i }))

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenLastCalledWith('/api/action-items?include_done=true')
    )
  })

  it('marks an item done and refetches the list', async () => {
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ ...ITEMS[0], status: 'done' }))
      }
      return Promise.resolve(jsonResponse(ITEMS))
    })

    render(<PlannerPage />)
    await waitFor(() => expect(screen.getByText('Overdue task')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('checkbox', { name: /mark done/i })[0])

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
    await waitFor(() => expect(screen.getByText('Overdue task')).toBeInTheDocument())

    fireEvent.click(screen.getAllByRole('checkbox', { name: /mark done/i })[0])

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
    expect(screen.getByText('Overdue task')).toBeInTheDocument()
  })

  it('shows the Later group, the Completed section, and a contact avatar/name when present', async () => {
    const EXTENDED_ITEMS = [
      { id: '4', text: 'Later task', direction: 'mine', status: 'open', due_date: '2026-08-01', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
      { id: '5', text: 'Done task', direction: 'mine', status: 'done', due_date: '2026-07-15', contact: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
      { id: '6', text: 'Contact task', direction: 'theirs', status: 'open', due_date: null, contact: { id: 'c1', display_name: 'Dana', email_address: 'dana@example.com' }, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z' },
    ]
    apiFetchMock.mockImplementation(() => Promise.resolve(jsonResponse(EXTENDED_ITEMS)))

    render(<PlannerPage />)

    await waitFor(() => expect(screen.getByText('Later task')).toBeInTheDocument())

    const laterHeading = screen.getByRole('heading', { name: 'Later' })
    expect(within(laterHeading.nextElementSibling as HTMLElement).getByText('Later task')).toBeInTheDocument()

    expect(screen.getByText(/Dana/)).toBeInTheDocument()
    expect(screen.getByText('D')).toBeInTheDocument()

    expect(screen.queryByText('Done task')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Completed' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: /show completed/i }))

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Completed' })).toBeInTheDocument())
    const completedHeading = screen.getByRole('heading', { name: 'Completed' })
    expect(within(completedHeading.nextElementSibling as HTMLElement).getByText('Done task')).toBeInTheDocument()
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

    await waitFor(() => expect(screen.getByText(/Call Gina/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /^schedule$/i })).toBeInTheDocument()
    expect(screen.getByText(/scheduled:/i)).toBeInTheDocument()
  })
})
```

Note exactly what changed from the original file and why:
1. `getByText('Due this week', { selector: 'li' })` → `{ selector: 'p' }` — the redesign replaces the `<ul>`/`<li>` group markup with `<div>`/`<p>` (matching the pattern already established for Contact detail's lists in Phase 3), so the selector disambiguating the item's own text from the section heading of the same name needs updating to the new tag.
2. Both `getAllByRole('button', { name: /mark done/i })` → `getAllByRole('checkbox', { name: /mark done/i })` — the done-toggle becomes a real (accent-tinted) `<input type="checkbox">` instead of a text-link `<button>`, which is a more correct semantic for a binary done/not-done state and is what the design spec explicitly calls for ("checkbox-style done toggle").
3. One assertion added (`expect(screen.getByText('D')).toBeInTheDocument()`) to the existing contact-name test, covering the new `getInitials`-based avatar.
Everything else (error/401/debounce-free fetch behavior, group membership, Completed-section toggle, Schedule control) is unchanged.

- [ ] **Step 2: Run tests to verify the changed ones fail**

Run: `npm --prefix frontend test -- planner/page.test.tsx`
Expected: 4 of 8 FAIL against the current page — the `{ selector: 'p' }` assertion (current markup uses `<li>`), both `getAllByRole('checkbox', { name: /mark done/i })` assertions (current markup uses `<button>`), and the new `getByText('D')` assertion (no avatar exists yet). The other 4 (error, 401, show-completed refetch, Schedule control) already PASS — they don't depend on any of this task's changes.

- [ ] **Step 3: Implement the redesigned Planner page**

Replace the full contents of `frontend/app/planner/page.tsx` with:

```tsx
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix frontend test -- planner/page.test.tsx`
Expected: PASS (8/8 tests)

- [ ] **Step 5: Run the full suite and the build**

Run:
```bash
npm --prefix frontend test
npm --prefix frontend run build
```
Expected: all tests pass, static export succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/planner/page.tsx frontend/app/planner/page.test.tsx
git commit -m "feat: redesign planner groups, items, and controls"
```

---

### Task 3: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete test suite**

Run: `npm --prefix frontend test`
Expected: all test files pass, including the rebuilt `ScheduleActionItemPanel.test.tsx`, `planner/page.test.tsx`, and every previously-existing test file.

- [ ] **Step 2: Run the linter**

Run: `npm --prefix frontend run lint`
Expected: only the 6 pre-existing errors confirmed present before Phase 1 started (`react-hooks/set-state-in-effect` in `contacts/view/page.tsx`, `dashboard/page.tsx`, `planner/page.tsx`, `search/page.tsx`; `@typescript-eslint/no-explicit-any` x2 in `lib/api.test.ts`) — line numbers may shift from this phase's edits to `planner/page.tsx`, but it must be the same pre-existing pattern, not a new one. Zero *new* errors from any file touched in this phase. If a genuinely new error appears, fix its root cause before proceeding — do not just document it.

- [ ] **Step 3: Run the static export build**

Run: `npm --prefix frontend run build`
Expected: build succeeds with no errors.

- [ ] **Step 4: Manual visual check**

Run: `npm --prefix frontend run dev`, open `http://localhost:3000/planner` in a browser, and confirm:
- Each group (Overdue/Due this week/Later/No due date/Completed) has a status-colored left border
- Each item shows an accent-tinted checkbox, a contact avatar + name when present, and a due-date badge when present
- Clicking "Schedule" opens a floating popover below the trigger (not an inline expanding list) with a fade+scale-in animation, a close (×) button, a toggle-switch for "Online meeting", and a grid of time-slot chips
- The popover doesn't get visually clipped by its containing card/list
- Clicking a time slot books it and closes the popover; clicking the × closes it without booking
