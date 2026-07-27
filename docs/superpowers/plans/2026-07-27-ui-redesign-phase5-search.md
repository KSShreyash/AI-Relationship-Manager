# UI Redesign Phase 5: Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Search page on top of the Phase 1-4 design system — card-based grouped results, client-side query-term highlighting, and a proper empty/idle state — with zero backend/API/data-model changes. This is the fifth and final phase of the redesign.

**Architecture:** Widen the shared `Input` primitive with an `aria-label` passthrough (its first real accessibility gap, flagged by the Phase 3 final review and deferred here as recommended), then rebuild the Search page's results as `Card` rows (matching Contacts/Planner) with a small local `highlightMatch` helper that wraps the matched substring in a `<mark>`, and an `EmptyState` for the pre-query idle screen.

**Tech Stack:** Next.js 16 (App Router, static export), React 19, TypeScript, Tailwind CSS v4, Vitest + Testing Library, `framer-motion`, `lucide-react`, `clsx` (all already installed).

## Global Constraints

- No backend changes. The only fetch is the pre-existing `/api/search?q=...` (`backend/app/api/v1/search.py`), which returns exactly `{ contacts: [{id, display_name, email_address, notes}], action_items: [{id, text, direction, status, due_date, contact}] }` — no other fields exist to build filter chips (Emails/Meetings/Files/AI Notes), keyboard-navigable result lists, or recent/suggested searches on top of. None of those are being built this phase.
- Color tokens already defined in `frontend/app/globals.css` (Phases 1-4) — no new tokens needed.
- No hardcoded hex/Tailwind-palette colors — everything through `var(--color-*)`.
- **Deliberate non-change:** the Phase 3 final review flagged `Input` using `focus:` (fires on any focus, including a mouse click) where `Button` uses `focus-visible:` (keyboard-only), calling it an inconsistency to fix "when `Input` is extended." Having now considered it: this is the *correct* convention for a text input, not a bug — every mainstream design system shows an input's focus ring on mouse-click focus too, because typing follows immediately (unlike a button, where `focus-visible` exists specifically to avoid a lingering ring after a single click-and-release). `Input` keeps `focus:`. Only the `aria-label` gap is being fixed this phase.
- `highlightMatch` (the query-substring wrapper) is a small helper local to `frontend/app/search/page.tsx`, not a shared `frontend/lib/` utility — it has exactly one consumer (this page, called twice), so a shared module would be premature abstraction. It returns a `<mark>` (the correct native element for this), tinted via a token-based `className` to override the browser's default yellow-on-black UA styling.
- `EmptyState` is used only for the pre-query idle state ("Type to search your contacts and action items.") — the spec ties `EmptyState` specifically to that state. The per-section "no matches" messages ("No matching contacts."/"No matching action items.") stay as simple muted paragraphs, matching the equivalent small inline empty messages already used elsewhere (e.g. Planner's "Nothing open."/"Nothing done yet.").
- **Testing note on highlighting:** wrapping a matched substring in `<mark>` splits what was previously a single text node into multiple nodes. Testing Library's `getByText` only matches an element's *direct* text-node children by default, not text inside nested elements — so any existing assertion doing `getByText(/whole phrase containing the query/i)` on text that will now contain a `<mark>` must be rewritten, either as `getByRole('link', { name: ... })` (the accessible-name algorithm *does* aggregate nested element text, so this keeps working unchanged) when the text is a link, or by reading a container's `.textContent` directly when it isn't. Every test in `frontend/app/search/page.test.tsx` affected by this is enumerated exactly in Task 2 below — do not guess at others.
- Follow `frontend/AGENTS.md`: `frontend/app/search/page.test.tsx` uses `vi.useFakeTimers()` (unscoped) combined with `fireEvent` — this is correct and must be preserved; do not introduce `userEvent` into it.

---

### Task 1: Widen `Input` with `aria-label`, and use it on the existing Contacts search box

**Files:**
- Modify: `frontend/app/components/ui/Input.tsx`
- Modify: `frontend/app/components/ui/Input.test.tsx`
- Modify: `frontend/app/contacts/page.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Input`'s prop type gains an optional `'aria-label'?: string`, forwarded to the underlying `<input>`'s `aria-label` attribute. Task 2 (Search page) relies on this to give its search box a real accessible name instead of relying solely on `placeholder` (which is not a reliable accessible name — some assistive technologies don't expose it as one).

- [ ] **Step 1: Write the failing test**

Add this test to the end of the `describe('Input', ...)` block in `frontend/app/components/ui/Input.test.tsx` (keep both existing tests unchanged):

```tsx
  it('applies an aria-label when provided', () => {
    render(<Input value="" onChange={vi.fn()} aria-label="Search" />)
    expect(screen.getByRole('textbox', { name: 'Search' })).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend test -- Input.test.tsx`
Expected: FAIL — the rendered input has no accessible name matching "Search".

- [ ] **Step 3: Implement the widened prop**

Replace the full contents of `frontend/app/components/ui/Input.tsx` with:

```tsx
import clsx from 'clsx'

type InputProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  type?: string
  'aria-label'?: string
}

export function Input({
  value,
  onChange,
  placeholder,
  className,
  type = 'text',
  'aria-label': ariaLabel,
}: InputProps) {
  return (
    <input
      type={type}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={clsx(
        'w-full rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm text-[var(--color-fg)] placeholder-[var(--color-muted)] transition focus:border-[var(--color-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/30',
        className
      )}
    />
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix frontend test -- Input.test.tsx`
Expected: PASS (3/3 tests)

- [ ] **Step 5: Add the same accessible name to the existing Contacts search box**

In `frontend/app/contacts/page.tsx`, find this line:
```tsx
        <Input value={search} onChange={setSearch} placeholder="Search contacts…" className="max-w-sm" />
```
Replace it with:
```tsx
        <Input
          value={search}
          onChange={setSearch}
          placeholder="Search contacts…"
          aria-label="Search contacts"
          className="max-w-sm"
        />
```
No test changes needed here — `frontend/app/contacts/page.test.tsx` doesn't assert on the input's accessible name, only its placeholder (`getByPlaceholderText`), which is unaffected.

- [ ] **Step 6: Run the full suite and the build to confirm no regressions**

Run:
```bash
npm --prefix frontend test
npm --prefix frontend run build
```
Expected: all tests pass, static export succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/components/ui/Input.tsx frontend/app/components/ui/Input.test.tsx frontend/app/contacts/page.tsx
git commit -m "feat: add aria-label support to Input, use it on Contacts search"
```

---

### Task 2: Redesign the Search page

**Files:**
- Modify: `frontend/app/search/page.tsx`
- Modify: `frontend/app/search/page.test.tsx`

**Interfaces:**
- Consumes: `Card` (`frontend/app/components/ui/Card.tsx`), `Input` (Task 1, with `aria-label`), `EmptyState` (`frontend/app/components/ui/EmptyState.tsx`), `getInitials` (`frontend/lib/getInitials.ts`).
- Produces: no interface changes — same default export, same fetch/debounce/stale-response-guarding logic (verbatim unchanged).

- [ ] **Step 1: Write the changed/new tests**

Replace the full contents of `frontend/app/search/page.test.tsx` with:

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, pushMock, routerMock } = vi.hoisted(() => {
  const pushMock = vi.fn()
  return { apiFetchMock: vi.fn(), pushMock, routerMock: { push: pushMock } }
})

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }))

import SearchPage from './page'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

describe('SearchPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    pushMock.mockReset()
  })

  it('shows an inline error instead of failing silently when the fetch throws', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockRejectedValue(new Error('network error'))

    render(<SearchPage />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'alice' } })
    await vi.advanceTimersByTimeAsync(300)

    await vi.waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())

    vi.useRealTimers()
  })

  it('redirects to login on a 401 (no session)', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(new Response(null, { status: 401 }))

    render(<SearchPage />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'alice' } })
    await vi.advanceTimersByTimeAsync(300)

    expect(pushMock).toHaveBeenCalledWith('/login')

    vi.useRealTimers()
  })

  it('shows a prompt before any query is typed', () => {
    render(<SearchPage />)

    expect(screen.getByText(/type to search/i)).toBeInTheDocument()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('debounces the query and shows grouped results', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        contacts: [
          { id: 'c1', display_name: 'Alice Johnson', email_address: 'alice@example.com', notes: 'Discussed the budget' },
        ],
        action_items: [
          { id: 'a1', text: 'Follow up with Alice', direction: 'mine', status: 'open', due_date: null,
            contact: { id: 'c1', display_name: 'Alice Johnson', email_address: 'alice@example.com' } },
        ],
      })
    )

    render(<SearchPage />)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'alice' } })
    await vi.advanceTimersByTimeAsync(300)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/search?q=alice')
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: /^contacts$/i })).toBeInTheDocument())

    const actionItemsHeading = screen.getByRole('heading', { name: /^action items$/i })
    const actionItemsList = actionItemsHeading.nextElementSibling as HTMLElement
    expect(actionItemsList.textContent).toMatch(/follow up with alice/i)

    const contactsHeading = screen.getByRole('heading', { name: /^contacts$/i })
    const contactsList = contactsHeading.nextElementSibling as HTMLElement
    expect(within(contactsList).getByRole('link', { name: 'Alice Johnson' })).toHaveAttribute('href', '/contacts/view?id=c1')
    expect(screen.getByText(/discussed the budget/i)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('highlights the matched query substring in a result', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(
      jsonResponse({
        contacts: [{ id: 'c1', display_name: 'Alice Johnson', email_address: 'alice@example.com', notes: null }],
        action_items: [],
      })
    )

    render(<SearchPage />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'alice' } })
    await vi.advanceTimersByTimeAsync(300)

    await vi.waitFor(() => expect(screen.getByRole('link', { name: 'Alice Johnson' })).toBeInTheDocument())
    const mark = screen.getByRole('link', { name: 'Alice Johnson' }).querySelector('mark')
    expect(mark).toHaveTextContent('Alice')

    vi.useRealTimers()
  })

  it('shows empty-state copy per section when a search returns nothing', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(jsonResponse({ contacts: [], action_items: [] }))

    render(<SearchPage />)
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'nomatch' } })
    await vi.advanceTimersByTimeAsync(300)

    await vi.waitFor(() => expect(screen.getByText(/no matching contacts/i)).toBeInTheDocument())
    expect(screen.getByText(/no matching action items/i)).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('shows an inline error and keeps prior results on failure', async () => {
    vi.useFakeTimers()
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse({
        contacts: [{ id: 'c1', display_name: 'Kept Contact', email_address: null, notes: null }],
        action_items: [],
      }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))

    render(<SearchPage />)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'kept' } })
    await vi.advanceTimersByTimeAsync(300)
    await vi.waitFor(() => expect(screen.getByRole('link', { name: 'Kept Contact' })).toBeInTheDocument())

    fireEvent.change(input, { target: { value: 'kept2' } })
    await vi.advanceTimersByTimeAsync(300)

    await vi.waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
    expect(screen.getByRole('link', { name: 'Kept Contact' })).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('debounces search input and ignores a stale out-of-order response', async () => {
    vi.useFakeTimers()

    let resolveFirst: (value: Response) => void = () => {}
    let resolveSecond: (value: Response) => void = () => {}
    apiFetchMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve })) // "sm"
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve })) // "smi"

    render(<SearchPage />)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'sm' } })
    await vi.advanceTimersByTimeAsync(300)
    fireEvent.change(input, { target: { value: 'smi' } })
    await vi.advanceTimersByTimeAsync(300)

    resolveSecond(jsonResponse({
      contacts: [{ id: '2', display_name: 'Smith', email_address: null, notes: null }],
      action_items: [],
    }))
    await vi.waitFor(() => expect(screen.getByRole('link', { name: 'Smith' })).toBeInTheDocument())

    resolveFirst(jsonResponse({
      contacts: [{ id: '3', display_name: 'Smiley', email_address: null, notes: null }],
      action_items: [],
    }))
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByRole('link', { name: 'Smith' })).toBeInTheDocument()
    expect(screen.queryByText('Smiley')).not.toBeInTheDocument()

    vi.useRealTimers()
  })

  it('ignores a stale response that resolves after the query was cleared', async () => {
    vi.useFakeTimers()

    let resolveFirst: (value: Response) => void = () => {}
    apiFetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve })) // "alice"

    render(<SearchPage />)
    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'alice' } })
    await vi.advanceTimersByTimeAsync(300)

    expect(apiFetchMock).toHaveBeenCalledWith('/api/search?q=alice')

    fireEvent.change(input, { target: { value: '' } })
    await vi.advanceTimersByTimeAsync(300)

    expect(screen.getByText(/type to search/i)).toBeInTheDocument()

    resolveFirst(jsonResponse({
      contacts: [{ id: 'c1', display_name: 'Stale Alice', email_address: null, notes: null }],
      action_items: [],
    }))
    // Flush several microtask turns so response.json() and any resulting
    // setState would have a chance to land before we assert it didn't.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0)
    }

    expect(screen.getByText(/type to search/i)).toBeInTheDocument()
    expect(screen.queryByText('Stale Alice')).not.toBeInTheDocument()

    vi.useRealTimers()
  })
})
```

Note exactly what changed from the original file and why, per the Global Constraints testing note:
1. "debounces the query and shows grouped results": the loose `getByText(/follow up with alice/i)` became a container-`textContent` check (the action item's text isn't a link, and once `highlightMatch` splits "Alice" into a `<mark>`, no single text node contains the whole phrase). The contact-name assertion became a `within(contactsList).getByRole('link', ...)` scoped to the Contacts section specifically — this fixture's action item references a contact also named "Alice Johnson", so the Action Items section renders a *second* link with the identical accessible name "Alice Johnson" (the contact-reference link, unrelated to `highlightMatch`); an unscoped `screen.getByRole('link', { name: 'Alice Johnson' })` would throw on "multiple elements found". The initial wait condition was changed from waiting on that (ambiguous) link to waiting on the unambiguous "Contacts" heading instead, for the same reason.
2. New test added: "highlights the matched query substring in a result" — directly verifies the `<mark>` exists with the expected text, which no existing test did.
3. "shows an inline error and keeps prior results on failure": both `getByText('Kept Contact')` occurrences became `getByRole('link', { name: 'Kept Contact' })` — same reasoning (the name is exact and short enough that even the first occurrence, where the query still actively matches and splits the text, needs the accessible-name query).
4. "debounces search input and ignores a stale out-of-order response": `getByText('Smith')` (both occurrights) became `getByRole('link', { name: 'Smith' })` — same reasoning (query `'smi'` matches within "Smith", splitting it).
5. Everything else — the error/401/prompt/empty-state/stale-after-cleared tests — is untouched, because none of their assertions exercise text that `highlightMatch` would ever split (either the query never matches that specific text, or the assertion is checking for absence).

- [ ] **Step 2: Run tests to verify the changed/new ones fail**

Run: `npm --prefix frontend test -- search/page.test.tsx`
Expected: only ONE test fails — "highlights the matched query substring in a result" (the current page has no `<mark>` element at all, so `.querySelector('mark')` finds nothing). Every other test, including "debounces the query and shows grouped results", "shows an inline error and keeps prior results on failure", and "debounces search input and ignores a stale out-of-order response" (all rewritten to use `getByRole('link', { name: ... })`/container-`textContent` instead of exact `getByText`), already PASS against the *current* unmodified page — those queries were rewritten to be robust against the redesign's `<mark>`-splitting, and role/accessible-name-based queries happen to also work fine against the old plain-text markup that has no splitting to worry about. This is expected: those 3 tests aren't a TDD red/green pair for this task, they're defensive rewrites that hold on both sides of the change. Don't be alarmed that they already pass — the actual new behavior this task adds (Card layout, EmptyState, and the `<mark>` highlighting) is what Step 3 introduces, and the highlight test is what proves it.

- [ ] **Step 3: Implement the redesigned Search page**

Replace the full contents of `frontend/app/search/page.tsx` with:

```tsx
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix frontend test -- search/page.test.tsx`
Expected: PASS (9/9 tests)

- [ ] **Step 5: Run the full suite and the build**

Run:
```bash
npm --prefix frontend test
npm --prefix frontend run build
```
Expected: all tests pass, static export succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/search/page.tsx frontend/app/search/page.test.tsx
git commit -m "feat: redesign search results as card lists with query highlighting"
```

---

### Task 3: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete test suite**

Run: `npm --prefix frontend test`
Expected: all test files pass, including `Input.test.tsx`, `search/page.test.tsx`, `contacts/page.test.tsx`, and every previously-existing test file.

- [ ] **Step 2: Run the linter**

Run: `npm --prefix frontend run lint`
Expected: only the 6 pre-existing errors confirmed present before Phase 1 started (`react-hooks/set-state-in-effect` in `contacts/view/page.tsx`, `dashboard/page.tsx`, `planner/page.tsx`, `search/page.tsx`; `@typescript-eslint/no-explicit-any` x2 in `lib/api.test.ts`) — line numbers may shift from this phase's edits to `search/page.tsx`, but it must be the same pre-existing pattern, not a new one. Zero *new* errors from any file touched in this phase. If a genuinely new error appears, fix its root cause before proceeding — do not just document it.

- [ ] **Step 3: Run the static export build**

Run: `npm --prefix frontend run build`
Expected: build succeeds with no errors.

- [ ] **Step 4: Manual visual check**

Run: `npm --prefix frontend run dev`, open `http://localhost:3000/search` in a browser, and confirm:
- The idle state (before typing) shows the icon/title empty-state treatment, not plain text
- Typing a query that matches contacts/action items shows them as card rows, avatars on contacts, and the matched substring visibly highlighted (accent-tinted, not the browser's default yellow `<mark>`)
- A query with no matches shows "No matching contacts."/"No matching action items." per section
- The search input has a visible focus ring on both click and keyboard focus (unchanged from before — this was a deliberate non-change, see Global Constraints)
