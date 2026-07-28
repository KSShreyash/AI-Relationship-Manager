# Storm Redesign Phase 4: Search Tabs/Recent-Searches + Schedule Popover Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Search a tab filter (All/People/Tasks) and a frontend-only "Recent searches" pill row, restyle its result rows for closer icon-row parity between contacts and action items, and give the Schedule popover a visual-only polish pass — completing the last phase of the Storm redesign.

**Architecture:** `search/page.tsx` gains client-side filter state (which section(s) render) and a `localStorage`-backed recent-searches list — no new endpoint, no change to the existing debounced `/api/search` fetch or its stale-response guard. `ScheduleActionItemPanel.tsx` gets a pure visual/typography/spacing pass with zero behavior change, so its existing test suite (already fully role/text-based, no styling assertions) needs no modification at all.

**Tech Stack:** Next.js 16 (App Router), React, TypeScript, Tailwind CSS v4, `lucide-react`, Vitest + Testing Library.

## Global Constraints

- Zero backend/API/data-model changes.
- All colors via `var(--color-*)` CSS custom properties — never hardcoded hex or Tailwind palette classes.
- The existing debounced fetch, `requestId`-based stale-response guard, and 401-redirect logic in `search/page.tsx` must remain byte-for-byte unchanged — only the surrounding filter/recent-searches state and result-rendering JSX may change.
- Search tabs are exactly **All / People / Tasks**, mapping to `results.contacts` / `results.action_items` — no Emails/Meetings/Files/AI Notes tabs, since `/api/search` only ever returns `contacts` and `action_items`.
- Recent searches: last 5 distinct non-empty queries, most recent first, persisted to `localStorage`, with a "Clear all" action — frontend-only, no backend involvement.
- The Schedule popover restyle changes only visual presentation (spacing, typography, panel dimensions) — no new fields (Duration/Date/Timezone/Advanced options), no change to the confirm-on-slot-click interaction, since `/api/action-items/{id}/schedule-suggestions` returns fixed pre-computed slots with nothing for extra controls to drive.
- Full spec: `docs/superpowers/specs/2026-07-28-storm-ui-redesign-design.md` (§7, §9).

---

### Task 1: Search — tab filter, recent searches, icon-row restyle

**Files:**
- Modify: `frontend/app/search/page.tsx` (full-file replacement — imports, state, and render all change together)
- Modify: `frontend/app/search/page.test.tsx` (append two new tests; all existing tests are unchanged and must keep passing as-is, since the default filter state reproduces today's unfiltered two-section behavior)

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: nothing consumed by a later task — Search is a leaf page.

- [ ] **Step 1: Replace `frontend/app/search/page.tsx` in full**

Replace the entire file content with:

```tsx
'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { ListChecks, Search as SearchIcon } from 'lucide-react'

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
type SearchFilter = 'all' | 'people' | 'tasks'

const FILTERS: { key: SearchFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'people', label: 'People' },
  { key: 'tasks', label: 'Tasks' },
]

const RECENT_SEARCHES_KEY = 'recent-searches'
const MAX_RECENT_SEARCHES = 5

function loadRecentSearches(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const stored = window.localStorage.getItem(RECENT_SEARCHES_KEY)
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

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
  const [filter, setFilter] = useState<SearchFilter>('all')
  const [recentSearches, setRecentSearches] = useState<string[]>(loadRecentSearches)
  const requestId = useRef(0)

  function recordRecentSearch(term: string) {
    setRecentSearches((prev) => {
      const next = [term, ...prev.filter((item) => item !== term)].slice(0, MAX_RECENT_SEARCHES)
      window.localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next))
      return next
    })
  }

  function clearRecentSearches() {
    setRecentSearches([])
    window.localStorage.removeItem(RECENT_SEARCHES_KEY)
  }

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
          recordRecentSearch(query)
        })
        .catch(() => {
          if (thisRequest === requestId.current) {
            setError('Something went wrong searching. Please try again.')
          }
        })
    }, 300)

    return () => clearTimeout(timer)
  }, [query, router])

  const showContacts = filter === 'all' || filter === 'people'
  const showTasks = filter === 'all' || filter === 'tasks'

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

      <div className="mt-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = filter === f.key
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={active}
              className={`rounded-[var(--radius-card)] px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? 'bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
                  : 'border border-[var(--color-border)] text-[var(--color-muted)] hover:text-[var(--color-fg)]'
              }`}
            >
              {f.label}
            </button>
          )
        })}
      </div>

      {recentSearches.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-[var(--color-muted)]">Recent:</span>
          {recentSearches.map((term) => (
            <button
              key={term}
              type="button"
              onClick={() => setQuery(term)}
              className="rounded-full border border-[var(--color-border)] px-3 py-1 text-xs text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-fg)]"
            >
              {term}
            </button>
          ))}
          <button
            type="button"
            onClick={clearRecentSearches}
            className="text-xs font-medium text-[var(--color-accent)] hover:underline"
          >
            Clear all
          </button>
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{error}</p>}

      {results === null ? (
        <EmptyState
          icon={SearchIcon}
          title="Type to search your contacts and action items."
          className="mt-6"
        />
      ) : (
        <>
          {showContacts && (
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
            </>
          )}

          {showTasks && (
            <>
              <h2 className="mt-6 text-sm font-semibold text-[var(--color-fg)]">Action Items</h2>
              {results.action_items.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--color-muted)]">No matching action items.</p>
              ) : (
                <div className="mt-2 space-y-3">
                  {results.action_items.map((item) => (
                    <Card key={item.id} className="flex items-center justify-between gap-4">
                      <div className="flex min-w-0 items-center gap-4">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-accent)]">
                          <ListChecks size={18} aria-hidden="true" />
                        </span>
                        <p className="min-w-0 truncate text-sm text-[var(--color-fg)]">
                          {highlightMatch(item.text, query)}
                        </p>
                      </div>
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
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Append two new tests to `frontend/app/search/page.test.tsx`**

Add `window.localStorage.clear()` to the existing `beforeEach` block (so recent-searches state starts empty and deterministic for every test — including ones written before this task, which never touch `localStorage` and are unaffected by the addition):

```tsx
  beforeEach(() => {
    apiFetchMock.mockReset()
    pushMock.mockReset()
    window.localStorage.clear()
  })
```

Then add these two tests at the end of the `describe('SearchPage', ...)` block, after the existing `'ignores a stale response that resolves after the query was cleared'` test:

```tsx
  it('filters results by tab: People hides Action Items, Tasks hides Contacts', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        contacts: [{ id: 'c1', display_name: 'Alice Johnson', email_address: 'alice@example.com', notes: null }],
        action_items: [
          { id: 'a1', text: 'Follow up with Alice', direction: 'mine', status: 'open', due_date: null, contact: null },
        ],
      })
    )

    render(<SearchPage />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'alice' } })
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: /^contacts$/i })).toBeInTheDocument())
    expect(screen.getByRole('heading', { name: /^action items$/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^people$/i }))
    expect(screen.getByRole('heading', { name: /^contacts$/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^action items$/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^tasks$/i }))
    expect(screen.queryByRole('heading', { name: /^contacts$/i })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^action items$/i })).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('remembers a successful search, lets you rerun it from the recent list, and clears the list', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(jsonResponse({ contacts: [], action_items: [] }))

    render(<SearchPage />)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'alice' } })
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'alice' })).toBeInTheDocument())

    fireEvent.change(input, { target: { value: '' } })
    await vi.advanceTimersByTimeAsync(300)
    expect(screen.getByRole('button', { name: 'alice' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'alice' }))
    await vi.advanceTimersByTimeAsync(300)
    expect(apiFetchMock).toHaveBeenLastCalledWith('/api/search?q=alice')

    fireEvent.click(screen.getByRole('button', { name: /clear all/i }))
    expect(screen.queryByRole('button', { name: 'alice' })).not.toBeInTheDocument()

    vi.useRealTimers()
  })
```

- [ ] **Step 3: Run the Search test file to verify everything passes**

Run: `cd frontend && npx vitest run app/search/page.test.tsx`
Expected: PASS, all tests in the file (9 pre-existing + 2 new = 11). The pre-existing tests pass unmodified because the default `filter` state is `'all'`, which reproduces today's unfiltered two-section rendering exactly.

- [ ] **Step 4: Run the full suite to confirm no other regressions**

Run: `cd frontend && npx vitest run`
Expected: all test files pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/search/page.tsx frontend/app/search/page.test.tsx
git commit -m "feat: add Search tab filter, recent searches, and icon-row action-item results"
```

---

### Task 2: Schedule popover — visual-only restyle

**Files:**
- Modify: `frontend/app/components/ScheduleActionItemPanel.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by a later task.

This is a pure visual pass — every prop, every fetch call, every piece of state, and every interaction (open/close, online-meeting toggle, click-a-slot-to-confirm) stays exactly as it is. The existing test suite (`ScheduleActionItemPanel.test.tsx`) asserts only on roles, text, and attributes (`aria-expanded`, disabled state, error text) — never on class names or spacing — so **no test changes are needed for this task**; the existing 9 tests must simply keep passing.

- [ ] **Step 1: Replace `frontend/app/components/ScheduleActionItemPanel.tsx` in full**

Replace the entire file content with:

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
          className="absolute right-0 top-full z-10 mt-2 w-80 rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-xl"
        >
          <div className="flex items-center justify-between">
            <span className="text-base font-semibold text-[var(--color-fg)]">Schedule meeting</span>
            <button
              onClick={closePanel}
              aria-label="Close"
              className="text-[var(--color-muted)] transition hover:text-[var(--color-fg)]"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{error}</p>}

          {slots === null ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">Loading suggestions…</p>
          ) : slots.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">No open slots found.</p>
          ) : (
            <>
              <label className="mt-4 flex items-center justify-between text-sm text-[var(--color-fg)]">
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

              <div className={`mt-4 grid grid-cols-2 gap-2.5 ${submitting ? 'opacity-50' : ''}`}>
                {slots.map((slot) => (
                  <button
                    key={slot.start}
                    onClick={() => confirm(slot)}
                    disabled={submitting}
                    className="rounded-[var(--radius-card)] border border-[var(--color-border)] px-3 py-2.5 text-xs font-medium text-[var(--color-fg)] transition hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 disabled:pointer-events-none"
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

Changes from the current file, all cosmetic: panel width `w-72` → `w-80`, padding `p-4` → `p-5`, heading `"Pick a time"` (`text-sm`) → `"Schedule meeting"` (`text-base`, matching the mockup's popover title and this app's sentence-case heading convention elsewhere), section top-margins `mt-3` → `mt-4`, slot grid gap `gap-2` → `gap-2.5`, slot button padding `px-2 py-2` → `px-3 py-2.5`, shadow `shadow-lg` → `shadow-xl`, close-button hover gets an explicit `transition`. No prop, state, fetch, or event-handler logic changed.

- [ ] **Step 2: Run the existing test suite to confirm nothing broke**

Run: `cd frontend && npx vitest run app/components/ScheduleActionItemPanel.test.tsx`
Expected: PASS (9/9) — unmodified, since every assertion targets roles/text/attributes, none of which changed.

- [ ] **Step 3: Run the full suite to confirm no other regressions**

Run: `cd frontend && npx vitest run`
Expected: all test files pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/components/ScheduleActionItemPanel.tsx
git commit -m "style: refine Schedule popover spacing, sizing, and heading copy"
```

---

## Phase 4 Verification

- [ ] Run the full suite once more: `cd frontend && npx vitest run`
- [ ] Run the project's lint command in `frontend/` and confirm zero new errors.
- [ ] Start the dev server and visually confirm: Search shows All/People/Tasks tabs that filter the two result sections, searching populates a "Recent" pill row that persists across a page reload (via `localStorage`), clicking a recent pill reruns that search, "Clear all" empties the row; the Schedule popover (from Planner or a Contact's action items) opens as a slightly larger, more spacious card titled "Schedule meeting" with the same slot-click-to-confirm behavior as before.
- [ ] This is the final phase of the Storm redesign — after this phase's final review and merge, do a full app walkthrough (Dashboard, Contacts, Planner, Search, Contact detail, Login) to confirm the palette, favicon, and every restyled page are consistent end to end.
