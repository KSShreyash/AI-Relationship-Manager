# UI Redesign Phase 3: Contacts + Contact Detail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Contacts list and Contact detail pages on top of the Phase 1/2 design system, adding the three shared primitives (`Badge`, `Input`, `EmptyState`) this phase needs, with zero backend/API/data-model changes.

**Architecture:** Build `Badge`, `Input`, `EmptyState` (deferred from Phase 1 per YAGNI — this phase is their first real consumer), plus two small pure-function utilities (`formatRelativeTime`, `getInitials`) shared between the two pages. Redesign the Contacts list as card rows with client-side sorting. Lightly restyle `ScheduleActionItemPanel` (token colors only — the full popover rebuild is Phase 4's job). Redesign Contact detail's profile header and lists on top of the same primitives.

**Tech Stack:** Next.js 16 (App Router, static export), React 19, TypeScript, Tailwind CSS v4, Vitest + Testing Library, `framer-motion`, `lucide-react`, `clsx` (all already installed).

## Global Constraints

- No backend changes. Every fetch in this phase hits an endpoint that already exists: `/api/contacts`, `/api/contacts/{id}`, `/api/contacts/{id}/action-items`, `/api/action-items/{id}/schedule-suggestions`, `/api/action-items/{id}/schedule`.
- Color tokens already defined in `frontend/app/globals.css` (Phases 1-2): `--color-bg`, `--color-bg-alt`, `--color-surface`, `--color-border`, `--color-accent`, `--color-accent-fg`, `--color-muted`, `--color-fg`, `--radius-card`, `--color-danger`, `--color-danger-border`, `--color-danger-surface`, `--color-warning`. No new tokens needed this phase.
- No hardcoded hex/Tailwind-palette colors in any component — everything through `var(--color-*)`.
- Dropped per the approved design spec (no backing data): company, role, department, relationship score, status badge, avatar photo. Contact avatars are initials-only, computed client-side.
- Avatar initials rule (exact): first letters of the first two words of `display_name` if present (e.g. "Jane Doe" → "JD"); otherwise the first letter of `email_address` before the `@`; otherwise `"?"`.
- Icons from `lucide-react` only. No new npm dependencies this phase.
- Every existing test in `frontend/app/contacts/page.test.tsx`, `frontend/app/contacts/view/page.test.tsx`, and `frontend/app/components/ScheduleActionItemPanel.test.tsx` must keep passing — tightened only where a pre-existing assertion was already fragile (documented per-task below), never loosened.
- Follow `frontend/AGENTS.md`: `frontend/app/contacts/page.test.tsx` mixes `vi.useFakeTimers()` with `fireEvent` (correct) — do not introduce `userEvent` into any test that also uses fake timers.

---

### Task 1: Build the `Badge` primitive

**Files:**
- Create: `frontend/app/components/ui/Badge.tsx`
- Create: `frontend/app/components/ui/Badge.test.tsx`

**Interfaces:**
- Produces: named export `Badge` from `frontend/app/components/ui/Badge.tsx`, typed as:
  ```ts
  type BadgeVariant = 'accent' | 'muted' | 'danger'
  type BadgeProps = { children: ReactNode; variant?: BadgeVariant; className?: string }
  function Badge(props: BadgeProps): JSX.Element
  ```
  Default `variant` is `'muted'`. Consumed by Task 4 (Contacts list, for the open-item-count badge).

- [ ] **Step 1: Write the failing test**

Create `frontend/app/components/ui/Badge.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Badge } from './Badge'

describe('Badge', () => {
  it('renders its children', () => {
    render(<Badge>3 open</Badge>)
    expect(screen.getByText('3 open')).toBeInTheDocument()
  })

  it('applies the accent variant', () => {
    render(<Badge variant="accent">Active</Badge>)
    expect(screen.getByText('Active')).toHaveClass('text-[var(--color-accent)]')
  })

  it('applies the muted variant', () => {
    render(<Badge variant="muted">Idle</Badge>)
    expect(screen.getByText('Idle')).toHaveClass('text-[var(--color-muted)]')
  })

  it('applies the danger variant', () => {
    render(<Badge variant="danger">Overdue</Badge>)
    expect(screen.getByText('Overdue')).toHaveClass('text-[var(--color-danger)]')
  })

  it('defaults to the muted variant', () => {
    render(<Badge>Default</Badge>)
    expect(screen.getByText('Default')).toHaveClass('text-[var(--color-muted)]')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend test -- Badge.test.tsx`
Expected: FAIL — `Cannot find module './Badge'`

- [ ] **Step 3: Implement `Badge`**

Create `frontend/app/components/ui/Badge.tsx`:

```tsx
import type { ReactNode } from 'react'
import clsx from 'clsx'

export type BadgeVariant = 'accent' | 'muted' | 'danger'

type BadgeProps = {
  children: ReactNode
  variant?: BadgeVariant
  className?: string
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  accent: 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]',
  muted: 'border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)]',
  danger: 'bg-[var(--color-danger-surface)] text-[var(--color-danger)]',
}

export function Badge({ children, variant = 'muted', className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        VARIANT_CLASSES[variant],
        className
      )}
    >
      {children}
    </span>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix frontend test -- Badge.test.tsx`
Expected: PASS (5/5 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/ui/Badge.tsx frontend/app/components/ui/Badge.test.tsx
git commit -m "feat: add shared Badge primitive"
```

---

### Task 2: Build the `Input` primitive

**Files:**
- Create: `frontend/app/components/ui/Input.tsx`
- Create: `frontend/app/components/ui/Input.test.tsx`

**Interfaces:**
- Produces: named export `Input` from `frontend/app/components/ui/Input.tsx`, typed as:
  ```ts
  type InputProps = {
    value: string
    onChange: (value: string) => void
    placeholder?: string
    className?: string
    type?: string
  }
  function Input(props: InputProps): JSX.Element
  ```
  Note: `onChange` receives the new string value directly (not the raw event) — simpler for consumers. Consumed by Task 4 (Contacts search box).

- [ ] **Step 1: Write the failing test**

Create `frontend/app/components/ui/Input.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Input } from './Input'

describe('Input', () => {
  it('renders the given value and placeholder', () => {
    render(<Input value="hello" onChange={vi.fn()} placeholder="Search…" />)
    expect(screen.getByPlaceholderText('Search…')).toHaveValue('hello')
  })

  it('calls onChange with the new string value', () => {
    const onChange = vi.fn()
    render(<Input value="" onChange={onChange} placeholder="Search…" />)
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'abc' } })
    expect(onChange).toHaveBeenCalledWith('abc')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend test -- Input.test.tsx`
Expected: FAIL — `Cannot find module './Input'`

- [ ] **Step 3: Implement `Input`**

Create `frontend/app/components/ui/Input.tsx`:

```tsx
import clsx from 'clsx'

type InputProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  type?: string
}

export function Input({ value, onChange, placeholder, className, type = 'text' }: InputProps) {
  return (
    <input
      type={type}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
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
Expected: PASS (2/2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/ui/Input.tsx frontend/app/components/ui/Input.test.tsx
git commit -m "feat: add shared Input primitive"
```

---

### Task 3: Build the `EmptyState` primitive

**Files:**
- Create: `frontend/app/components/ui/EmptyState.tsx`
- Create: `frontend/app/components/ui/EmptyState.test.tsx`

**Interfaces:**
- Produces: named export `EmptyState` from `frontend/app/components/ui/EmptyState.tsx`, typed as:
  ```ts
  type EmptyStateProps = {
    icon: LucideIcon
    title: string
    description?: string
    action?: ReactNode
    className?: string
  }
  function EmptyState(props: EmptyStateProps): JSX.Element
  ```
  Consumed by Task 4 (Contacts list's empty state).

- [ ] **Step 1: Write the failing test**

Create `frontend/app/components/ui/EmptyState.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Users } from 'lucide-react'

import { EmptyState } from './EmptyState'

describe('EmptyState', () => {
  it('renders the title', () => {
    render(<EmptyState icon={Users} title="No contacts yet" />)
    expect(screen.getByText('No contacts yet')).toBeInTheDocument()
  })

  it('renders the description when provided', () => {
    render(<EmptyState icon={Users} title="No contacts yet" description="Sync and extract to get started." />)
    expect(screen.getByText('Sync and extract to get started.')).toBeInTheDocument()
  })

  it('omits the description paragraph when not provided', () => {
    const { container } = render(<EmptyState icon={Users} title="No contacts yet" />)
    expect(container.querySelectorAll('p')).toHaveLength(1)
  })

  it('renders the action when provided', () => {
    render(<EmptyState icon={Users} title="No contacts yet" action={<button>Sync now</button>} />)
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend test -- EmptyState.test.tsx`
Expected: FAIL — `Cannot find module './EmptyState'`

- [ ] **Step 3: Implement `EmptyState`**

Create `frontend/app/components/ui/EmptyState.tsx`:

```tsx
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import clsx from 'clsx'

type EmptyStateProps = {
  icon: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={clsx('flex flex-col items-center gap-3 py-12 text-center', className)}>
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-muted)]">
        <Icon size={22} aria-hidden="true" />
      </span>
      <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
      {description && <p className="max-w-sm text-sm text-[var(--color-muted)]">{description}</p>}
      {action}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix frontend test -- EmptyState.test.tsx`
Expected: PASS (4/4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/ui/EmptyState.tsx frontend/app/components/ui/EmptyState.test.tsx
git commit -m "feat: add shared EmptyState primitive"
```

---

### Task 4: Redesign the Contacts list page

**Files:**
- Create: `frontend/lib/formatRelativeTime.ts`
- Create: `frontend/lib/formatRelativeTime.test.ts`
- Create: `frontend/lib/getInitials.ts`
- Create: `frontend/lib/getInitials.test.ts`
- Modify: `frontend/app/contacts/page.tsx`
- Modify: `frontend/app/contacts/page.test.tsx`

**Interfaces:**
- Consumes: `Card` (`frontend/app/components/ui/Card.tsx`), `Badge`/`Input`/`EmptyState` (Tasks 1-3), `Button` (`frontend/app/components/ui/Button.tsx`).
- Produces: named export `formatRelativeTime(iso: string, now: Date): string` from `frontend/lib/formatRelativeTime.ts`, and named export `getInitials(displayName: string | null, email: string | null): string` from `frontend/lib/getInitials.ts`. Task 6 (Contact detail) reuses `getInitials`.

- [ ] **Step 1: Write the failing test for `formatRelativeTime`**

Create `frontend/lib/formatRelativeTime.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { formatRelativeTime } from './formatRelativeTime'

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-27T12:00:00Z')

  it('returns "just now" for under a minute', () => {
    expect(formatRelativeTime('2026-07-27T11:59:45Z', now)).toBe('just now')
  })

  it('returns minutes for under an hour', () => {
    expect(formatRelativeTime('2026-07-27T11:45:00Z', now)).toBe('15m ago')
  })

  it('returns hours for under a day', () => {
    expect(formatRelativeTime('2026-07-27T06:00:00Z', now)).toBe('6h ago')
  })

  it('returns days for under a month', () => {
    expect(formatRelativeTime('2026-07-17T12:00:00Z', now)).toBe('10d ago')
  })

  it('returns months for under a year', () => {
    expect(formatRelativeTime('2026-01-27T12:00:00Z', now)).toBe('6mo ago')
  })

  it('returns years for a year or more', () => {
    expect(formatRelativeTime('2024-07-27T12:00:00Z', now)).toBe('2y ago')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend test -- formatRelativeTime.test.ts`
Expected: FAIL — `Cannot find module './formatRelativeTime'`

- [ ] **Step 3: Implement `formatRelativeTime`**

Create `frontend/lib/formatRelativeTime.ts`:

```ts
export function formatRelativeTime(iso: string, now: Date): string {
  const then = new Date(iso)
  const diffMs = now.getTime() - then.getTime()
  const diffMinutes = Math.round(diffMs / 60000)

  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`

  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`

  const diffDays = Math.round(diffHours / 24)
  if (diffDays < 30) return `${diffDays}d ago`

  const diffMonths = Math.round(diffDays / 30)
  if (diffMonths < 12) return `${diffMonths}mo ago`

  const diffYears = Math.round(diffMonths / 12)
  return `${diffYears}y ago`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix frontend test -- formatRelativeTime.test.ts`
Expected: PASS (6/6 tests)

- [ ] **Step 5: Write the failing test for `getInitials`**

Create `frontend/lib/getInitials.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { getInitials } from './getInitials'

describe('getInitials', () => {
  it('uses the first letters of the first two words of the display name', () => {
    expect(getInitials('Jane Doe', 'jane@example.com')).toBe('JD')
  })

  it('uses only one letter for a single-word display name', () => {
    expect(getInitials('Cher', 'cher@example.com')).toBe('C')
  })

  it('falls back to the first letter of the email when there is no display name', () => {
    expect(getInitials(null, 'jane@example.com')).toBe('J')
  })

  it('falls back to a question mark when there is no display name or email', () => {
    expect(getInitials(null, null)).toBe('?')
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm --prefix frontend test -- getInitials.test.ts`
Expected: FAIL — `Cannot find module './getInitials'`

- [ ] **Step 7: Implement `getInitials`**

Create `frontend/lib/getInitials.ts`:

```ts
export function getInitials(displayName: string | null, email: string | null): string {
  if (displayName) {
    const words = displayName.trim().split(/\s+/).slice(0, 2)
    return words.map((word) => word.charAt(0).toUpperCase()).join('')
  }
  if (email) return email.charAt(0).toUpperCase()
  return '?'
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm --prefix frontend test -- getInitials.test.ts`
Expected: PASS (4/4 tests)

- [ ] **Step 9: Write the failing tests for the redesigned Contacts page**

Replace the full contents of `frontend/app/contacts/page.test.tsx` with:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, pushMock, routerMock } = vi.hoisted(() => {
  const pushMock = vi.fn()
  return { apiFetchMock: vi.fn(), pushMock, routerMock: { push: pushMock } }
})

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }))

import ContactsPage from './page'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('ContactsPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    pushMock.mockReset()
  })

  it('shows an error instead of hanging on Loading when the fetch throws', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockRejectedValue(new Error('network error'))

    render(<ContactsPage />)
    await vi.advanceTimersByTimeAsync(300)

    await vi.waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())

    vi.useRealTimers()
  })

  it('redirects to login on a 401 (no session)', async () => {
    vi.useFakeTimers()
    apiFetchMock.mockResolvedValue(new Response(null, { status: 401 }))

    render(<ContactsPage />)
    await vi.advanceTimersByTimeAsync(300)

    expect(pushMock).toHaveBeenCalledWith('/login')

    vi.useRealTimers()
  })

  it('renders contacts with their open action item count and a working link', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse([
        { id: '1', email_address: 'alice@example.com', display_name: 'Alice', open_action_item_count: 2, updated_at: '2026-07-17T10:00:00Z' },
      ])
    )

    render(<ContactsPage />)

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument())
    expect(screen.getByText('2 open')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /alice/i })).toHaveAttribute('href', '/contacts/view?id=1')
  })

  it('shows an empty state when there are no contacts', async () => {
    apiFetchMock.mockResolvedValue(jsonResponse([]))

    render(<ContactsPage />)

    await waitFor(() =>
      expect(screen.getByText(/no contacts yet/i)).toBeInTheDocument()
    )
  })

  it('sorts by recency by default, and alphabetically when Name is selected', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse([
        { id: '1', email_address: 'zeta@example.com', display_name: 'Zeta', open_action_item_count: 0, updated_at: '2026-07-20T10:00:00Z' },
        { id: '2', email_address: 'alpha@example.com', display_name: 'Alpha', open_action_item_count: 0, updated_at: '2026-07-10T10:00:00Z' },
      ])
    )

    render(<ContactsPage />)
    await waitFor(() => expect(screen.getByText('Zeta')).toBeInTheDocument())

    let links = screen.getAllByRole('link')
    expect(links[0]).toHaveAccessibleName(/zeta/i)
    expect(links[1]).toHaveAccessibleName(/alpha/i)

    fireEvent.click(screen.getByRole('button', { name: /^name$/i }))

    links = screen.getAllByRole('link')
    expect(links[0]).toHaveAccessibleName(/alpha/i)
    expect(links[1]).toHaveAccessibleName(/zeta/i)
  })

  it('debounces search input and ignores a stale out-of-order response', async () => {
    vi.useFakeTimers()

    let resolveFirst: (value: Response) => void = () => {}
    let resolveSecond: (value: Response) => void = () => {}
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse([])) // initial load
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve })) // "sm" search
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve })) // "smi" search

    render(<ContactsPage />)
    await vi.advanceTimersByTimeAsync(300)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)

    const input = screen.getByPlaceholderText(/search/i)
    fireEvent.change(input, { target: { value: 'sm' } })
    await vi.advanceTimersByTimeAsync(300)
    fireEvent.change(input, { target: { value: 'smi' } })
    await vi.advanceTimersByTimeAsync(300)

    // Later request ("smi") resolves first, earlier request ("sm") resolves second (stale).
    resolveSecond(
      jsonResponse([
        { id: '2', email_address: 'smith@example.com', display_name: 'Smith', open_action_item_count: 0, updated_at: '2026-07-17T10:00:00Z' },
      ])
    )
    await vi.waitFor(() => expect(screen.getByText('Smith')).toBeInTheDocument())

    resolveFirst(
      jsonResponse([
        { id: '3', email_address: 'smiley@example.com', display_name: 'Smiley', open_action_item_count: 0, updated_at: '2026-07-17T10:00:00Z' },
      ])
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByText('Smith')).toBeInTheDocument()
    expect(screen.queryByText('Smiley')).not.toBeInTheDocument()

    vi.useRealTimers()
  })
})
```

Note what changed from the original test file and why: the "2" assertion was tightened from a loose `/2/` substring match to an exact `'2 open'` match (the loose version risked colliding with digits that could appear in a rendered relative-time string, e.g. "2mo ago"); a new sort-toggle test was added; everything else (error/401/empty-state/debounce behavior) is verbatim unchanged.

- [ ] **Step 10: Run tests to verify the new/changed ones fail**

Run: `npm --prefix frontend test -- contacts/page.test.tsx`
Expected: 2 of 6 FAIL against the current page — "renders contacts with their open action item count and a working link" (old markup renders "2 open action items", not the exact text "2 open") and "sorts by recency by default, and alphabetically when Name is selected" (no sort toggle buttons exist yet). The other 4 (error, 401, empty-state, debounce) already PASS — the old markup already renders "No contacts yet" and already redirects/errors correctly, so those double as regression coverage this task must not break.

- [ ] **Step 11: Implement the redesigned Contacts page**

Replace the full contents of `frontend/app/contacts/page.tsx` with:

```tsx
'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Users } from 'lucide-react'

import { apiFetch } from '@/lib/api'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import { getInitials } from '@/lib/getInitials'
import { Badge } from '@/app/components/ui/Badge'
import { Button } from '@/app/components/ui/Button'
import { Card } from '@/app/components/ui/Card'
import { EmptyState } from '@/app/components/ui/EmptyState'
import { Input } from '@/app/components/ui/Input'

type Contact = {
  id: string
  email_address: string | null
  display_name: string | null
  open_action_item_count: number
  updated_at: string
}

type SortMode = 'recent' | 'name'

function sortContacts(contacts: Contact[], mode: SortMode): Contact[] {
  const copy = [...contacts]
  if (mode === 'name') {
    copy.sort((a, b) =>
      (a.display_name ?? a.email_address ?? '').localeCompare(b.display_name ?? b.email_address ?? '')
    )
  } else {
    copy.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
  }
  return copy
}

export default function ContactsPage() {
  const router = useRouter()
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [error, setError] = useState(false)
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('recent')
  const requestId = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      const thisRequest = ++requestId.current
      const query = search ? `?q=${encodeURIComponent(search)}` : ''
      apiFetch(`/api/contacts${query}`)
        .then(async (response) => {
          if (response.status === 401) {
            router.push('/login')
            return
          }
          if (!response.ok) {
            if (thisRequest === requestId.current) setError(true)
            return
          }
          const body = await response.json()
          if (thisRequest === requestId.current) {
            setError(false)
            setContacts(body)
          }
        })
        .catch(() => {
          if (thisRequest === requestId.current) setError(true)
        })
    }, 300)

    return () => clearTimeout(timer)
  }, [search, router])

  const sortedContacts = contacts ? sortContacts(contacts, sortMode) : null

  return (
    <div className="p-8">
      <h1 className="text-xl font-bold text-[var(--color-fg)]">Contacts</h1>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Input value={search} onChange={setSearch} placeholder="Search contacts…" className="max-w-sm" />
        <div className="flex gap-2">
          <Button variant={sortMode === 'recent' ? 'primary' : 'secondary'} onClick={() => setSortMode('recent')}>
            Recent
          </Button>
          <Button variant={sortMode === 'name' ? 'primary' : 'secondary'} onClick={() => setSortMode('name')}>
            Name
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-danger)]">
          Something went wrong loading your contacts.
        </p>
      )}

      {sortedContacts === null ? (
        error ? null : <p className="mt-4 text-sm text-[var(--color-muted)]">Loading…</p>
      ) : sortedContacts.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No contacts yet"
          description="Sync and extract to get started."
          className="mt-4"
        />
      ) : (
        <div className="mt-4 space-y-3">
          {sortedContacts.map((contact) => (
            <Card key={contact.id} hoverable className="flex items-center justify-between gap-4">
              <a
                href={`/contacts/view?id=${contact.id}`}
                aria-label={contact.display_name ?? contact.email_address ?? undefined}
                className="flex min-w-0 flex-1 items-center gap-4"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-sm font-semibold text-[var(--color-accent)]">
                  {getInitials(contact.display_name, contact.email_address)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-[var(--color-fg)]">
                    {contact.display_name ?? contact.email_address}
                  </span>
                  {contact.email_address && (
                    <span className="block truncate text-xs text-[var(--color-muted)]">{contact.email_address}</span>
                  )}
                </span>
              </a>
              <div className="flex shrink-0 items-center gap-3">
                <Badge variant={contact.open_action_item_count > 0 ? 'accent' : 'muted'}>
                  {contact.open_action_item_count} open
                </Badge>
                <span className="text-xs text-[var(--color-muted)]">
                  {formatRelativeTime(contact.updated_at, new Date())}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 12: Run tests to verify they pass**

Run: `npm --prefix frontend test -- contacts/page.test.tsx`
Expected: PASS (6/6 tests)

- [ ] **Step 13: Run the full suite and the build**

Run:
```bash
npm --prefix frontend test
npm --prefix frontend run build
```
Expected: all tests pass, static export succeeds.

- [ ] **Step 14: Commit**

```bash
git add frontend/lib/formatRelativeTime.ts frontend/lib/formatRelativeTime.test.ts frontend/lib/getInitials.ts frontend/lib/getInitials.test.ts frontend/app/contacts/page.tsx frontend/app/contacts/page.test.tsx
git commit -m "feat: redesign contacts list as card rows with sorting"
```

---

### Task 5: Lightly restyle `ScheduleActionItemPanel`

**Files:**
- Modify: `frontend/app/components/ScheduleActionItemPanel.tsx`

**Interfaces:**
- Consumes: nothing new. Same props, same exported default, same behavior.
- Produces: no interface changes — this is a pure color-token restyle. The full popover/grid rebuild described in the design spec is explicitly Phase 4's job; this task only swaps hardcoded Tailwind colors for the design-system's CSS custom properties so it doesn't look out of place next to the redesigned Contact detail page.

This task introduces no new behavior, so there are no new tests to write — the existing `frontend/app/components/ScheduleActionItemPanel.test.tsx` (5 tests) is the regression net.

- [ ] **Step 1: Confirm the existing tests pass before touching anything**

Run: `npm --prefix frontend test -- ScheduleActionItemPanel.test.tsx`
Expected: PASS (5/5 tests) — this is your baseline.

- [ ] **Step 2: Restyle the component**

Replace the full contents of `frontend/app/components/ScheduleActionItemPanel.tsx` with:

```tsx
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
      <button onClick={openPanel} className="ml-2 text-sm font-medium text-[var(--color-accent)] hover:underline">
        Schedule
      </button>
    )
  }

  return (
    <span className="ml-2 inline-block">
      {error && <p role="alert" className="text-[var(--color-danger)]">{error}</p>}
      {slots === null ? (
        <span className="text-[var(--color-muted)]">Loading suggestions…</span>
      ) : slots.length === 0 ? (
        <span className="text-[var(--color-muted)]">No open slots found.</span>
      ) : (
        <>
          <label className="text-[var(--color-fg)]">
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
                <button
                  onClick={() => confirm(slot)}
                  disabled={submitting}
                  className="text-sm font-medium text-[var(--color-accent)] hover:underline disabled:opacity-50"
                >
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
```

- [ ] **Step 3: Run the existing tests to verify they still pass unmodified**

Run: `npm --prefix frontend test -- ScheduleActionItemPanel.test.tsx`
Expected: PASS (5/5 tests) — same count as Step 1's baseline, zero test-file changes.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/components/ScheduleActionItemPanel.tsx
git commit -m "style: apply design tokens to ScheduleActionItemPanel"
```

---

### Task 6: Redesign the Contact detail page

**Files:**
- Modify: `frontend/app/contacts/view/page.tsx`

**Interfaces:**
- Consumes: `getInitials` (Task 4, `@/lib/getInitials`), `Card` (`frontend/app/components/ui/Card.tsx`), the restyled `ScheduleActionItemPanel` (Task 5).
- Produces: no interface changes — this is a pure visual restyle. Every existing state variable, handler, and the two `/api/contacts/*` fetch calls are unchanged.

This task introduces no new behavior, so there are no new tests to write — the existing `frontend/app/contacts/view/page.test.tsx` (6 tests) is the regression net.

- [ ] **Step 1: Confirm the existing tests pass before touching anything**

Run: `npm --prefix frontend test -- contacts/view/page.test.tsx`
Expected: PASS (6/6 tests) — this is your baseline.

- [ ] **Step 2: Restyle the page**

Replace the full contents of `frontend/app/contacts/view/page.tsx` with:

```tsx
'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import { apiFetch } from '@/lib/api'
import { getInitials } from '@/lib/getInitials'
import ScheduleActionItemPanel from '@/app/components/ScheduleActionItemPanel'
import { Card } from '@/app/components/ui/Card'

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
    <Suspense fallback={<p className="p-8 text-[var(--color-muted)]">Loading…</p>}>
      <ContactProfileContent />
    </Suspense>
  )
}

function ContactProfileContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const id = searchParams.get('id')
  const [state, setState] = useState<State>({ state: 'loading' })

  const load = useCallback(async () => {
    if (!id) {
      setState({ state: 'not_found' })
      return
    }

    try {
      const contactResponse = await apiFetch(`/api/contacts/${id}`)
      if (contactResponse.status === 401) {
        router.push('/login')
        return
      }
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
    } catch {
      setState({ state: 'error' })
    }
  }, [id, router])

  useEffect(() => {
    load()
  }, [load])

  if (state.state === 'loading') {
    return (
      <div className="p-8">
        <p className="text-[var(--color-muted)]">Loading…</p>
      </div>
    )
  }
  if (state.state === 'not_found') {
    return (
      <div className="p-8">
        <p className="text-[var(--color-muted)]">Contact not found.</p>
      </div>
    )
  }
  if (state.state === 'error') {
    return (
      <div className="p-8">
        <p role="alert" className="text-[var(--color-danger)]">Something went wrong loading this contact.</p>
      </div>
    )
  }

  const { contact, actionItems } = state
  const openItems = actionItems.filter((item) => item.status === 'open')
  const doneItems = actionItems.filter((item) => item.status === 'done')

  return (
    <div className="p-8">
      <Card className="flex items-center gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)]/10 text-lg font-semibold text-[var(--color-accent)]">
          {getInitials(contact.display_name, contact.email_address)}
        </span>
        <div>
          <h1 className="text-xl font-bold text-[var(--color-fg)]">
            {contact.display_name ?? contact.email_address}
          </h1>
          {contact.email_address && <p className="text-sm text-[var(--color-muted)]">{contact.email_address}</p>}
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Member since{' '}
            {new Date(contact.created_at).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </p>
        </div>
      </Card>

      <Card className="mt-4">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">AI summary</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">{contact.notes ?? 'No notes yet.'}</p>
      </Card>

      <h2 className="mt-6 text-sm font-semibold text-[var(--color-fg)]">Open</h2>
      {openItems.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">Nothing open.</p>
      ) : (
        <div className="mt-2 divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          {openItems.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-[var(--color-fg)]">
              <span>{item.text}</span>
              <ScheduleActionItemPanel
                itemId={item.id}
                scheduledCalendarEventId={item.scheduled_calendar_event_id}
                scheduledStartTime={item.scheduled_start_time}
                contact={contact}
                onScheduled={load}
              />
            </div>
          ))}
        </div>
      )}

      <h2 className="mt-6 text-sm font-semibold text-[var(--color-fg)]">Done</h2>
      {doneItems.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--color-muted)]">Nothing done yet.</p>
      ) : (
        <div className="mt-2 divide-y divide-[var(--color-border)] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)]">
          {doneItems.map((item) => (
            <p key={item.id} className="px-4 py-3 text-sm text-[var(--color-muted)] line-through">
              {item.text}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Run the existing tests to verify they still pass unmodified**

Run: `npm --prefix frontend test -- contacts/view/page.test.tsx`
Expected: PASS (6/6 tests) — same count as Step 1's baseline, zero test-file changes.

- [ ] **Step 4: Run the full suite and the build**

Run:
```bash
npm --prefix frontend test
npm --prefix frontend run build
```
Expected: all tests pass, static export succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/app/contacts/view/page.tsx
git commit -m "feat: redesign contact detail profile header and lists"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete test suite**

Run: `npm --prefix frontend test`
Expected: all test files pass, including the 3 new primitives, the 2 new lib utilities, and every previously-existing test file.

- [ ] **Step 2: Run the linter**

Run: `npm --prefix frontend run lint`
Expected: only the 6 pre-existing errors confirmed present before Phase 1 started (`react-hooks/set-state-in-effect` in `contacts/view/page.tsx`, `dashboard/page.tsx`, `planner/page.tsx`, `search/page.tsx`; `@typescript-eslint/no-explicit-any` x2 in `lib/api.test.ts`) — line numbers may shift from this phase's edits to `contacts/view/page.tsx`, but it must be the same pre-existing pattern, not a new one. Zero *new* errors from any file touched in this phase. If a genuinely new error appears (as happened in Phase 2 with `NavBar.tsx`), fix its root cause before proceeding — do not just document it.

- [ ] **Step 3: Run the static export build**

Run: `npm --prefix frontend run build`
Expected: build succeeds with no errors.

- [ ] **Step 4: Manual visual check**

Run: `npm --prefix frontend run dev`, open `http://localhost:3000/contacts` and `http://localhost:3000/contacts/view?id=<some-id>` in a browser, and confirm:
- Contacts render as hoverable card rows with initials avatars, name/email, an open-item-count badge, and a relative "last updated" time
- "Recent" / "Name" sort toggle actually reorders the list
- Search still filters (debounced)
- Empty state (no contacts) shows the icon/title/description
- Contact detail shows a profile header with a larger avatar and "Member since" date, notes in an "AI summary" card, and Open/Done lists with a working "Schedule" control
