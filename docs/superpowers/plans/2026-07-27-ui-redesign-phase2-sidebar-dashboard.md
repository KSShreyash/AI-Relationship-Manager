# UI Redesign Phase 2: Sidebar + Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the sidebar chrome and the Dashboard page on top of the Phase 1 design system, adding a tasks-remaining gauge, with zero backend/API/data-model changes.

**Architecture:** Widen the shared `Button` primitive to support `aria-label` (needed for the sidebar's icon-only collapse toggle), redesign `NavBar` (icons, animated active indicator, collapsible rail, real user identity in the footer), then redesign the Dashboard page's KPI/activity sections on top of `Button`/`Card`, and add a new `TasksRemainingGauge` presentational component fed by a second existing endpoint (`/api/action-items?include_done=true`).

**Tech Stack:** Next.js 16 (App Router, static export), React 19, TypeScript, Tailwind CSS v4, Vitest + Testing Library, `framer-motion`, `lucide-react`, `clsx` (all already installed from Phase 1).

## Global Constraints

- No backend changes. Every fetch in this phase hits an endpoint that already exists and is already consumed elsewhere in the app: `/api/me/graph-status`, `/api/dashboard`, `/api/action-items?include_done=true`.
- Color tokens already defined in `frontend/app/globals.css` (Phase 1): `--color-bg`, `--color-bg-alt`, `--color-surface`, `--color-border`, `--color-accent`, `--color-accent-fg`, `--color-muted`, `--color-fg`, `--radius-card`, `--color-danger`, `--color-danger-border`, `--color-danger-surface`. This phase adds one more: `--color-warning: #FBBF24` (amber, for the gauge's mid zone).
- No hardcoded hex/Tailwind-palette colors in any component — everything through `var(--color-*)`.
- Motion: `framer-motion`, ~200ms ease-out, no bounce/spring overshoot, consistent with Phase 1.
- Gauge color zones by `open / total` ratio: **green** (`var(--color-accent)`) at `<= 0.33`, **amber** (`var(--color-warning)`) at `0.33–0.66`, **red** (`var(--color-danger)`) at `> 0.66`. Empty state (`total === 0`): render at 0% in the green zone with the label "No tasks yet".
- Icons from `lucide-react` only — no emoji, no other icon library.
- Every existing test in `frontend/app/dashboard/page.test.tsx` must keep passing (updated only where this phase's new fetch call requires the mock to handle a new path — never by loosening an assertion).
- Follow `frontend/AGENTS.md`: use `fireEvent`, not `userEvent`, in any NEW test that doesn't need real timers/async user interaction simulation. The existing dashboard test file already uses `@testing-library/user-event` for click-and-wait flows with real (non-fake) timers — that pattern is fine and must be preserved as-is; do not convert it to `fireEvent`.
- Only `Button`, `Card`, `lucide-react` icons, and `framer-motion` may be used as new UI building blocks — no new npm dependencies this phase.

---

### Task 1: Widen `Button` to support `aria-label`

**Files:**
- Modify: `frontend/app/components/ui/Button.tsx`
- Modify: `frontend/app/components/ui/Button.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Button`'s prop type gains an optional `'aria-label'?: string`, forwarded to the underlying `<motion.button>`'s `aria-label` attribute. Task 2 (NavBar's collapse toggle) relies on this to give an icon-only button an accessible name.

- [ ] **Step 1: Write the failing test**

Add this test to the end of the `describe('Button', ...)` block in `frontend/app/components/ui/Button.test.tsx` (keep all 4 existing tests unchanged, just add this one):

```tsx
  it('applies an aria-label when provided', () => {
    render(<Button aria-label="Collapse sidebar">×</Button>)
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend test -- Button.test.tsx`
Expected: FAIL — the rendered button has no accessible name matching "Collapse sidebar" (its accessible name currently falls back to its text content, "×").

- [ ] **Step 3: Implement the widened prop**

Replace the full contents of `frontend/app/components/ui/Button.tsx` with:

```tsx
'use client'

import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import clsx from 'clsx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

type ButtonProps = {
  variant?: ButtonVariant
  className?: string
  children: ReactNode
  onClick?: () => void
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
  'aria-label'?: string
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:brightness-110',
  secondary:
    'border border-[var(--color-border)] bg-transparent text-[var(--color-fg)] hover:border-[var(--color-accent)]',
  ghost: 'text-[var(--color-muted)] hover:text-[var(--color-fg)]',
  danger:
    'border border-[var(--color-danger-border)] text-[var(--color-danger)] hover:bg-[var(--color-danger-surface)]',
}

export function Button({
  variant = 'primary',
  className,
  children,
  onClick,
  type = 'button',
  disabled = false,
  'aria-label': ariaLabel,
}: ButtonProps) {
  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      whileHover={disabled ? undefined : { y: -1 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius-card)] px-4 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50 disabled:pointer-events-none',
        VARIANT_CLASSES[variant],
        className
      )}
    >
      {children}
    </motion.button>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix frontend test -- Button.test.tsx`
Expected: PASS (5/5 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions, then commit**

Run: `npm --prefix frontend test`
Expected: all tests pass (57 from Phase 1, now 58).

```bash
git add frontend/app/components/ui/Button.tsx frontend/app/components/ui/Button.test.tsx
git commit -m "feat: add aria-label support to Button for icon-only usage"
```

---

### Task 2: Redesign the sidebar shell (icons, active indicator, collapse)

**Files:**
- Create: `frontend/app/components/NavBar.test.tsx` (no test file exists for NavBar today)
- Modify: `frontend/app/components/NavBar.tsx`

**Interfaces:**
- Consumes: `Button` (`aria-label` prop from Task 1) from `frontend/app/components/ui/Button.tsx`.
- Produces: same default export `NavBar`, same behavior for chrome-hiding and sign-out; adds a `collapsed` UI state (not exported, internal) persisted under the `localStorage` key `'nav-collapsed'`. Task 3 (footer identity) extends this same file.

- [ ] **Step 1: Write the failing tests**

Create `frontend/app/components/NavBar.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signOutMock = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: signOutMock } }),
}))

let mockPathname = '/dashboard'
const pushMock = vi.fn()

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: pushMock }),
}))

import NavBar from './NavBar'

describe('NavBar', () => {
  beforeEach(() => {
    signOutMock.mockReset()
    pushMock.mockReset()
    window.localStorage.clear()
    mockPathname = '/dashboard'
  })

  it('renders nothing on chrome-hidden paths', () => {
    mockPathname = '/login'
    const { container } = render(<NavBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders all nav links with the correct hrefs', () => {
    render(<NavBar />)
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/dashboard')
    expect(screen.getByRole('link', { name: /contacts/i })).toHaveAttribute('href', '/contacts')
    expect(screen.getByRole('link', { name: /planner/i })).toHaveAttribute('href', '/planner')
    expect(screen.getByRole('link', { name: /search/i })).toHaveAttribute('href', '/search')
  })

  it('marks only the active link with aria-current', () => {
    mockPathname = '/contacts'
    render(<NavBar />)
    expect(screen.getByRole('link', { name: /contacts/i })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /dashboard/i })).not.toHaveAttribute('aria-current')
  })

  it('signs out and redirects to login on click', async () => {
    render(<NavBar />)
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/login'))
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })

  it('toggles collapsed state and persists it to localStorage', () => {
    render(<NavBar />)
    const toggle = screen.getByRole('button', { name: /collapse sidebar/i })

    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument()
    expect(window.localStorage.getItem('nav-collapsed')).toBe('true')
  })

  it('restores collapsed state from localStorage on mount', () => {
    window.localStorage.setItem('nav-collapsed', 'true')
    render(<NavBar />)
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix frontend test -- NavBar.test.tsx`
Expected: 3 of 6 FAIL against the current `NavBar.tsx` — "marks only the active link with aria-current" (old markup sets no `aria-current` at all), "toggles collapsed state and persists it to localStorage", and "restores collapsed state from localStorage on mount" (no collapse toggle button exists yet). The other 3 ("renders nothing on chrome-hidden paths", "renders all nav links with the correct hrefs", "signs out and redirects to login on click") incidentally PASS already — the old component already hides on those paths, already renders links with those hrefs/text, and already has a working sign-out handler. That's fine: TDD only requires the *new* behavior to start red, and these 3 double as regression coverage for behavior this task must not break.

- [ ] **Step 3: Implement the redesigned sidebar shell**

Replace the full contents of `frontend/app/components/NavBar.tsx` with:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import { ChevronsLeft, ChevronsRight, LayoutDashboard, ListTodo, LogOut, Search, Users } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { Button } from '@/app/components/ui/Button'

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/contacts', label: 'Contacts', icon: Users },
  { href: '/planner', label: 'Planner', icon: ListTodo },
  { href: '/search', label: 'Search', icon: Search },
]

const CHROME_HIDDEN_PATHS = new Set(['/', '/login', '/callback'])
const COLLAPSE_STORAGE_KEY = 'nav-collapsed'

export default function NavBar() {
  const pathname = usePathname()
  const router = useRouter()
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const stored = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
    if (stored === 'true') setCollapsed(true)
  }, [])

  if (CHROME_HIDDEN_PATHS.has(pathname)) return null

  function toggleCollapsed() {
    const next = !collapsed
    setCollapsed(next)
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next))
  }

  async function handleSignOut() {
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  return (
    <motion.nav
      animate={{ width: collapsed ? 72 : 224 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="flex shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-bg-alt)] px-3 py-6"
    >
      <div className="mb-8 flex items-center justify-between px-1">
        {!collapsed && (
          <span className="truncate text-sm font-semibold tracking-wide text-[var(--color-fg)]">
            AI Relationship Manager
          </span>
        )}
        <Button
          variant="ghost"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleCollapsed}
        >
          {collapsed ? <ChevronsRight size={16} aria-hidden="true" /> : <ChevronsLeft size={16} aria-hidden="true" />}
        </Button>
      </div>

      <div className="flex flex-1 flex-col gap-1">
        {NAV_LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`)
          const Icon = link.icon
          return (
            <a
              key={link.href}
              href={link.href}
              aria-current={active ? 'page' : undefined}
              className={`relative flex items-center gap-3 rounded-[var(--radius-card)] px-3 py-2 text-sm transition ${
                active ? 'text-[var(--color-fg)]' : 'text-[var(--color-muted)] hover:text-[var(--color-fg)]'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="nav-active-bg"
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="absolute inset-0 rounded-[var(--radius-card)] bg-[var(--color-accent)]/10"
                />
              )}
              {active && (
                <motion.span
                  layoutId="nav-active-bar"
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-[var(--color-accent)]"
                />
              )}
              <Icon size={18} className="relative shrink-0" aria-hidden="true" />
              {!collapsed && <span className="relative truncate">{link.label}</span>}
            </a>
          )
        })}
      </div>

      <button
        onClick={handleSignOut}
        aria-label="Sign out"
        className="mt-6 flex items-center gap-3 rounded-[var(--radius-card)] px-3 py-2 text-left text-sm text-[var(--color-muted)] transition hover:text-[var(--color-fg)]"
      >
        <LogOut size={18} aria-hidden="true" />
        {!collapsed && <span>Sign out</span>}
      </button>
    </motion.nav>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix frontend test -- NavBar.test.tsx`
Expected: PASS (6/6 tests)

- [ ] **Step 5: Run the full suite and the build to confirm nothing else broke**

Run:
```bash
npm --prefix frontend test
npm --prefix frontend run build
```
Expected: all tests pass, static export succeeds (this changes `layout.tsx`'s only chrome component, so a full regression pass matters here).

- [ ] **Step 6: Commit**

```bash
git add frontend/app/components/NavBar.tsx frontend/app/components/NavBar.test.tsx
git commit -m "feat: redesign sidebar with icons, active indicator, and collapse"
```

---

### Task 3: Sidebar footer — real user identity

**Files:**
- Modify: `frontend/app/components/NavBar.tsx`
- Modify: `frontend/app/components/NavBar.test.tsx`

**Interfaces:**
- Consumes: `apiFetch` from `@/lib/api` (existing, used elsewhere by `frontend/app/dashboard/page.tsx`).
- Produces: no new exports — adds a best-effort footer identity display to the existing `NavBar` default export.

- [ ] **Step 1: Write the failing tests**

Add these two tests to the end of the `describe('NavBar', ...)` block in `frontend/app/components/NavBar.test.tsx`, and add the `apiFetch` mock setup. Replace the full contents of the file with:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))
const signOutMock = vi.fn()

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: signOutMock } }),
}))

let mockPathname = '/dashboard'
const pushMock = vi.fn()

vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: pushMock }),
}))

import NavBar from './NavBar'

describe('NavBar', () => {
  beforeEach(() => {
    signOutMock.mockReset()
    pushMock.mockReset()
    apiFetchMock.mockReset()
    apiFetchMock.mockResolvedValue(new Response(null, { status: 401 }))
    window.localStorage.clear()
    mockPathname = '/dashboard'
  })

  it('renders nothing on chrome-hidden paths', () => {
    mockPathname = '/login'
    const { container } = render(<NavBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders all nav links with the correct hrefs', () => {
    render(<NavBar />)
    expect(screen.getByRole('link', { name: /dashboard/i })).toHaveAttribute('href', '/dashboard')
    expect(screen.getByRole('link', { name: /contacts/i })).toHaveAttribute('href', '/contacts')
    expect(screen.getByRole('link', { name: /planner/i })).toHaveAttribute('href', '/planner')
    expect(screen.getByRole('link', { name: /search/i })).toHaveAttribute('href', '/search')
  })

  it('marks only the active link with aria-current', () => {
    mockPathname = '/contacts'
    render(<NavBar />)
    expect(screen.getByRole('link', { name: /contacts/i })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /dashboard/i })).not.toHaveAttribute('aria-current')
  })

  it('signs out and redirects to login on click', async () => {
    render(<NavBar />)
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/login'))
    expect(signOutMock).toHaveBeenCalledTimes(1)
  })

  it('toggles collapsed state and persists it to localStorage', () => {
    render(<NavBar />)
    const toggle = screen.getByRole('button', { name: /collapse sidebar/i })

    fireEvent.click(toggle)

    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument()
    expect(window.localStorage.getItem('nav-collapsed')).toBe('true')
  })

  it('restores collapsed state from localStorage on mount', () => {
    window.localStorage.setItem('nav-collapsed', 'true')
    render(<NavBar />)
    expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument()
  })

  it('shows the connected user email and initial in the footer', async () => {
    apiFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ graph_me: { mail: 'jane@example.com' } }), { status: 200 })
    )
    render(<NavBar />)
    await waitFor(() => expect(screen.getByText('jane@example.com')).toBeInTheDocument())
    expect(screen.getByText('J')).toBeInTheDocument()
  })

  it('does not fetch graph-status on chrome-hidden paths', () => {
    mockPathname = '/login'
    render(<NavBar />)
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify the two new ones fail**

Run: `npm --prefix frontend test -- NavBar.test.tsx`
Expected: the 6 existing tests still PASS; "shows the connected user email and initial in the footer" and "does not fetch graph-status on chrome-hidden paths" FAIL (`NavBar` doesn't call `apiFetch` yet).

- [ ] **Step 3: Add the footer identity fetch**

In `frontend/app/components/NavBar.tsx`:

1. Add to the imports at the top:
```tsx
import { apiFetch } from '@/lib/api'
```

2. Add this state and effect inside the `NavBar` function, right after the existing `collapsed` `useEffect` block (still before the `if (CHROME_HIDDEN_PATHS.has(pathname)) return null` line):

```tsx
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    if (CHROME_HIDDEN_PATHS.has(pathname)) return
    let cancelled = false
    apiFetch('/api/me/graph-status')
      .then(async (response) => {
        if (!response.ok || cancelled) return
        const body = await response.json()
        const address = body.graph_me?.mail ?? body.graph_me?.userPrincipalName
        if (address && !cancelled) setEmail(address)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [pathname])
```

3. Insert this block immediately before the existing `<button onClick={handleSignOut} ...>` element (still inside the same `<motion.nav>`):

```tsx
      {email && (
        <div className="mt-4 flex items-center gap-3 border-t border-[var(--color-border)] px-1 pt-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-xs font-semibold text-[var(--color-accent)]">
            {email.charAt(0).toUpperCase()}
          </span>
          {!collapsed && <span className="truncate text-sm text-[var(--color-fg)]">{email}</span>}
        </div>
      )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix frontend test -- NavBar.test.tsx`
Expected: PASS (8/8 tests)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `npm --prefix frontend test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/components/NavBar.tsx frontend/app/components/NavBar.test.tsx
git commit -m "feat: show real connected-account identity in sidebar footer"
```

---

### Task 4: Dashboard — KPI cards, activity timeline, and button restyle

**Files:**
- Modify: `frontend/app/dashboard/page.tsx`

**Interfaces:**
- Consumes: `Button` and `Card` from Phase 1 (`frontend/app/components/ui/Button.tsx`, `frontend/app/components/ui/Card.tsx`).
- Produces: no interface changes — this is a pure visual restyle. Every existing state variable, handler, and the `/api/dashboard` + `/api/me/graph-status` fetch calls are unchanged. Task 5 adds a third fetch to this same file.

This task introduces no new behavior, so there are no new tests to write — the existing `frontend/app/dashboard/page.test.tsx` (6 tests) is the regression net. If any of its 6 tests fail after this change, that's a real defect: the visual restyle broke behavior it wasn't supposed to touch.

- [ ] **Step 1: Confirm the existing tests pass before touching anything**

Run: `npm --prefix frontend test -- dashboard/page.test.tsx`
Expected: PASS (6/6 tests) — this is your baseline.

- [ ] **Step 2: Restyle the page**

Replace the full contents of `frontend/app/dashboard/page.tsx` with:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ListChecks, ListPlus, UserRound, Users } from 'lucide-react'

import { apiFetch } from '@/lib/api'
import { Button } from '@/app/components/ui/Button'
import { Card } from '@/app/components/ui/Card'

type GraphStatus =
  | { state: 'loading' }
  | { state: 'connected'; email: string }
  | { state: 'needs_reauth' }
  | { state: 'error' }

type ActivityEntry =
  | { type: 'contact_updated'; id: string; timestamp: string; display_name: string | null; email_address: string | null }
  | { type: 'action_item_created'; id: string; timestamp: string; text: string; direction: 'mine' | 'theirs' }

type DashboardData = {
  contact_count: number
  open_action_item_count: number
  activity: ActivityEntry[]
}

export default function DashboardPage() {
  const router = useRouter()
  const [status, setStatus] = useState<GraphStatus>({ state: 'loading' })
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [triggerError, setTriggerError] = useState<string | null>(null)
  const [pending, setPending] = useState<'sync' | 'extract' | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const response = await apiFetch('/api/me/graph-status')

      if (response.status === 401) {
        router.push('/login')
        return
      }
      if (response.status === 409) {
        setStatus({ state: 'needs_reauth' })
        return
      }
      if (!response.ok) {
        setStatus({ state: 'error' })
        return
      }

      const body = await response.json()
      setStatus({
        state: 'connected',
        email: body.graph_me?.mail ?? body.graph_me?.userPrincipalName,
      })
    } catch {
      setStatus({ state: 'error' })
    }
  }, [router])

  const loadDashboard = useCallback(async () => {
    try {
      const response = await apiFetch('/api/dashboard')
      if (!response.ok) return
      setDashboard(await response.json())
    } catch {
      // Non-fatal: the connection status (loadStatus) already surfaces a
      // page-level error if the backend is unreachable. A stats-fetch
      // failure alone just leaves the stats section blank.
    }
  }, [])

  useEffect(() => {
    loadStatus()
    loadDashboard()
  }, [loadStatus, loadDashboard])

  async function runTrigger(kind: 'sync' | 'extract') {
    setPending(kind)
    setTriggerError(null)
    const path = kind === 'sync' ? '/api/sync/run/me' : '/api/extraction/run/me'
    const response = await apiFetch(path, { method: 'POST' })
    setPending(null)
    if (!response.ok) {
      setTriggerError('Something went wrong running that. Please try again.')
      return
    }
    await loadDashboard()
  }

  if (status.state === 'loading') {
    return (
      <div className="p-8">
        <p className="text-[var(--color-muted)]">Loading…</p>
      </div>
    )
  }

  if (status.state === 'needs_reauth') {
    return (
      <div className="p-8">
        <p className="text-[var(--color-fg)]">
          Your Microsoft connection expired.{' '}
          <a href="/login" className="text-[var(--color-accent)] hover:underline">
            Reconnect your Microsoft account
          </a>
          .
        </p>
      </div>
    )
  }

  if (status.state === 'error') {
    return (
      <div className="p-8">
        <p role="alert" className="text-[var(--color-danger)]">Something went wrong loading your account.</p>
      </div>
    )
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[var(--color-fg)]">Dashboard</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">Connected as {status.email}</p>
        </div>

        <div className="flex gap-3">
          <Button onClick={() => runTrigger('sync')} disabled={pending !== null}>
            Sync now
          </Button>
          <Button variant="secondary" onClick={() => runTrigger('extract')} disabled={pending !== null}>
            Extract now
          </Button>
        </div>
      </div>

      {triggerError && <p role="alert" className="mt-3 text-sm text-[var(--color-danger)]">{triggerError}</p>}

      {dashboard && (
        <>
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Card className="flex items-center gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
                <Users size={20} aria-hidden="true" />
              </span>
              <div>
                <p className="text-2xl font-bold text-[var(--color-fg)]">{dashboard.contact_count}</p>
                <p className="mt-1 text-sm text-[var(--color-muted)]">Contacts</p>
              </div>
            </Card>
            <Card className="flex items-center gap-4">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
                <ListChecks size={20} aria-hidden="true" />
              </span>
              <div>
                <p className="text-2xl font-bold text-[var(--color-fg)]">{dashboard.open_action_item_count}</p>
                <p className="mt-1 text-sm text-[var(--color-muted)]">Open action items</p>
              </div>
            </Card>
          </div>

          <Card className="mt-6">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">Recent activity</h2>
            {dashboard.activity.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--color-muted)]">No recent activity.</p>
            ) : (
              <ul className="mt-4 space-y-4">
                {dashboard.activity.map((entry) => {
                  const Icon = entry.type === 'contact_updated' ? UserRound : ListPlus
                  return (
                    <li key={`${entry.type}-${entry.id}`} className="flex gap-3 text-sm">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-accent)]">
                        <Icon size={16} aria-hidden="true" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[var(--color-fg)]">
                          {entry.type === 'contact_updated'
                            ? `Updated contact: ${entry.display_name ?? entry.email_address}`
                            : `New action item (${entry.direction}): ${entry.text}`}
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                          {new Date(entry.timestamp).toLocaleString()}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Run the existing tests to verify they still pass unmodified**

Run: `npm --prefix frontend test -- dashboard/page.test.tsx`
Expected: PASS (6/6 tests) — same count as Step 1's baseline, zero test-file changes.

- [ ] **Step 4: Commit**

```bash
git add frontend/app/dashboard/page.tsx
git commit -m "feat: restyle dashboard KPI cards and activity feed"
```

---

### Task 5: Dashboard — tasks-remaining gauge

**Files:**
- Create: `frontend/app/components/TasksRemainingGauge.tsx`
- Create: `frontend/app/components/TasksRemainingGauge.test.tsx`
- Modify: `frontend/app/globals.css`
- Modify: `frontend/app/dashboard/page.tsx`
- Modify: `frontend/app/dashboard/page.test.tsx`

**Interfaces:**
- Consumes: nothing new for the gauge component itself (pure presentational, props only).
- Produces: named export `TasksRemainingGauge` from `frontend/app/components/TasksRemainingGauge.tsx`, typed as:
  ```ts
  type TasksRemainingGaugeProps = { open: number; total: number }
  function TasksRemainingGauge(props: TasksRemainingGaugeProps): JSX.Element
  ```
  Renders an SVG arc gauge plus a text label ("`{open}` open of `{total}` total", or "No tasks yet" when `total === 0`). Consumed by `frontend/app/dashboard/page.tsx` in this same task.

- [ ] **Step 1: Add the amber gauge-zone color token**

In `frontend/app/globals.css`, inside the existing `:root { ... }` block, add one line immediately after `--color-danger-surface: #2A1214;`:

```css
  --color-warning: #FBBF24;
```

Do not change anything else in this file.

- [ ] **Step 2: Write the failing test for the gauge component**

Create `frontend/app/components/TasksRemainingGauge.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TasksRemainingGauge } from './TasksRemainingGauge'

describe('TasksRemainingGauge', () => {
  it('shows "No tasks yet" when total is 0', () => {
    render(<TasksRemainingGauge open={0} total={0} />)
    expect(screen.getByText('No tasks yet')).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '0 open of 0 total tasks')
  })

  it('shows the open/total label', () => {
    render(<TasksRemainingGauge open={2} total={10} />)
    expect(screen.getByText('2 open of 10 total')).toBeInTheDocument()
  })

  it('uses the green zone color when the open ratio is 0.33 or below', () => {
    const { container } = render(<TasksRemainingGauge open={3} total={10} />)
    const progressPath = container.querySelectorAll('path')[1]
    expect(progressPath).toHaveAttribute('stroke', 'var(--color-accent)')
  })

  it('uses the amber zone color when the open ratio is between 0.33 and 0.66', () => {
    const { container } = render(<TasksRemainingGauge open={5} total={10} />)
    const progressPath = container.querySelectorAll('path')[1]
    expect(progressPath).toHaveAttribute('stroke', 'var(--color-warning)')
  })

  it('uses the red zone color when the open ratio is above 0.66', () => {
    const { container } = render(<TasksRemainingGauge open={8} total={10} />)
    const progressPath = container.querySelectorAll('path')[1]
    expect(progressPath).toHaveAttribute('stroke', 'var(--color-danger)')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm --prefix frontend test -- TasksRemainingGauge.test.tsx`
Expected: FAIL — `Cannot find module './TasksRemainingGauge'`

- [ ] **Step 4: Implement the gauge component**

Create `frontend/app/components/TasksRemainingGauge.tsx`:

```tsx
type TasksRemainingGaugeProps = {
  open: number
  total: number
}

const GREEN_MAX_RATIO = 0.33
const AMBER_MAX_RATIO = 0.66

function zoneColor(ratio: number): string {
  if (ratio <= GREEN_MAX_RATIO) return 'var(--color-accent)'
  if (ratio <= AMBER_MAX_RATIO) return 'var(--color-warning)'
  return 'var(--color-danger)'
}

export function TasksRemainingGauge({ open, total }: TasksRemainingGaugeProps) {
  const ratio = total > 0 ? open / total : 0
  const percentage = Math.min(100, Math.max(0, ratio * 100))
  const color = zoneColor(ratio)

  return (
    <div className="flex flex-col items-center">
      <svg
        viewBox="0 0 200 110"
        className="w-full max-w-[220px]"
        role="img"
        aria-label={`${open} open of ${total} total tasks`}
      >
        <path
          d="M 10 100 A 90 90 0 0 1 190 100"
          fill="none"
          stroke="var(--color-border)"
          strokeWidth="16"
          strokeLinecap="round"
        />
        <path
          d="M 10 100 A 90 90 0 0 1 190 100"
          fill="none"
          stroke={color}
          strokeWidth="16"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={100}
          strokeDashoffset={100 - percentage}
          style={{ transition: 'stroke-dashoffset 0.2s ease-out, stroke 0.2s ease-out' }}
        />
      </svg>
      <p className="-mt-4 text-lg font-bold text-[var(--color-fg)]">
        {total === 0 ? 'No tasks yet' : `${open} open of ${total} total`}
      </p>
    </div>
  )
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --prefix frontend test -- TasksRemainingGauge.test.tsx`
Expected: PASS (5/5 tests)

- [ ] **Step 6: Write the failing tests for the dashboard integration**

Replace the full contents of `frontend/app/dashboard/page.test.tsx` with:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { apiFetchMock, pushMock, routerMock } = vi.hoisted(() => {
  const pushMock = vi.fn()
  return { apiFetchMock: vi.fn(), pushMock, routerMock: { push: pushMock } }
})

vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }))
vi.mock('next/navigation', () => ({ useRouter: () => routerMock }))

import DashboardPage from './page'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status })
}

const DASHBOARD_BODY = {
  contact_count: 3,
  open_action_item_count: 2,
  activity: [
    { type: 'action_item_created', id: 'a1', timestamp: '2026-07-17T10:00:00Z', text: 'Send the deck', direction: 'mine' },
    { type: 'contact_updated', id: 'c1', timestamp: '2026-07-17T09:00:00Z', display_name: 'Helen', email_address: 'helen@example.com' },
  ],
}

const ACTION_ITEMS_BODY = [
  { id: 'i1', status: 'open' },
  { id: 'i2', status: 'open' },
  { id: 'i3', status: 'done' },
]

describe('DashboardPage', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
    pushMock.mockReset()
  })

  it('shows an error instead of hanging on Loading when the fetch throws', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/me/graph-status') {
        return Promise.reject(new Error('network error'))
      }
      if (path === '/api/action-items?include_done=true') {
        return Promise.resolve(jsonResponse(ACTION_ITEMS_BODY))
      }
      return Promise.resolve(jsonResponse(DASHBOARD_BODY))
    })

    render(<DashboardPage />)

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
  })

  it('redirects to login on a 401 (no session)', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(new Response(null, { status: 401 }))
      }
      if (path === '/api/action-items?include_done=true') {
        return Promise.resolve(jsonResponse(ACTION_ITEMS_BODY))
      }
      return Promise.resolve(jsonResponse(DASHBOARD_BODY))
    })

    render(<DashboardPage />)

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/login'))
  })

  it('shows connection status, stats, and activity feed', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(jsonResponse({ graph_me: { mail: 'user@example.com' } }))
      }
      if (path === '/api/dashboard') {
        return Promise.resolve(jsonResponse(DASHBOARD_BODY))
      }
      if (path === '/api/action-items?include_done=true') {
        return Promise.resolve(jsonResponse(ACTION_ITEMS_BODY))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<DashboardPage />)

    await waitFor(() => expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument())
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText(/Send the deck/)).toBeInTheDocument()
    expect(screen.getByText(/Helen/)).toBeInTheDocument()
  })

  it('shows a reconnect prompt on 409 needs_reauth', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(new Response(null, { status: 409 }))
      }
      if (path === '/api/action-items?include_done=true') {
        return Promise.resolve(jsonResponse(ACTION_ITEMS_BODY))
      }
      return Promise.resolve(jsonResponse(DASHBOARD_BODY))
    })

    render(<DashboardPage />)

    await waitFor(() =>
      expect(screen.getByText(/reconnect your microsoft account/i)).toBeInTheDocument()
    )
  })

  it('triggers a sync and refetches the dashboard on success', async () => {
    const user = userEvent.setup()
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(jsonResponse({ graph_me: { mail: 'user@example.com' } }))
      }
      if (path === '/api/dashboard') {
        return Promise.resolve(jsonResponse(DASHBOARD_BODY))
      }
      if (path === '/api/action-items?include_done=true') {
        return Promise.resolve(jsonResponse(ACTION_ITEMS_BODY))
      }
      if (path === '/api/sync/run/me' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ status: 'ok' }))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /sync now/i }))

    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith('/api/sync/run/me', { method: 'POST' })
    )
  })

  it('shows an inline error and re-enables the button when sync fails', async () => {
    const user = userEvent.setup()
    apiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(jsonResponse({ graph_me: { mail: 'user@example.com' } }))
      }
      if (path === '/api/dashboard') {
        return Promise.resolve(jsonResponse(DASHBOARD_BODY))
      }
      if (path === '/api/action-items?include_done=true') {
        return Promise.resolve(jsonResponse(ACTION_ITEMS_BODY))
      }
      if (path === '/api/sync/run/me' && init?.method === 'POST') {
        return Promise.resolve(new Response(null, { status: 500 }))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument())

    const button = screen.getByRole('button', { name: /sync now/i })
    await user.click(button)

    await waitFor(() => expect(screen.getByText(/something went wrong/i)).toBeInTheDocument())
    expect(button).not.toBeDisabled()
  })

  it('shows the tasks-remaining gauge with the real open/total counts', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(jsonResponse({ graph_me: { mail: 'user@example.com' } }))
      }
      if (path === '/api/dashboard') {
        return Promise.resolve(jsonResponse(DASHBOARD_BODY))
      }
      if (path === '/api/action-items?include_done=true') {
        return Promise.resolve(jsonResponse(ACTION_ITEMS_BODY))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<DashboardPage />)

    await waitFor(() => expect(screen.getByText('2 open of 3 total')).toBeInTheDocument())
  })

  it('leaves the gauge section blank when the action-items fetch fails', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/me/graph-status') {
        return Promise.resolve(jsonResponse({ graph_me: { mail: 'user@example.com' } }))
      }
      if (path === '/api/dashboard') {
        return Promise.resolve(jsonResponse(DASHBOARD_BODY))
      }
      if (path === '/api/action-items?include_done=true') {
        return Promise.resolve(new Response(null, { status: 500 }))
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    render(<DashboardPage />)

    await waitFor(() => expect(screen.getByText('Connected as user@example.com')).toBeInTheDocument())
    expect(screen.queryByText(/open of .* total/)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 7: Run tests to verify the two new ones fail**

Run: `npm --prefix frontend test -- dashboard/page.test.tsx`
Expected: the 6 pre-existing tests still PASS; "shows the tasks-remaining gauge..." and "leaves the gauge section blank..." FAIL (the page doesn't fetch `/api/action-items?include_done=true` yet).

- [ ] **Step 8: Wire the gauge into the dashboard page**

In `frontend/app/dashboard/page.tsx`:

1. Add to the imports at the top:
```tsx
import { TasksRemainingGauge } from '@/app/components/TasksRemainingGauge'
```

2. Add this state and loader function, right after the existing `loadDashboard` `useCallback` block:

```tsx
  const [taskTotals, setTaskTotals] = useState<{ open: number; total: number } | null>(null)

  const loadTaskTotals = useCallback(async () => {
    try {
      const response = await apiFetch('/api/action-items?include_done=true')
      if (!response.ok) return
      const items: { status: 'open' | 'done' }[] = await response.json()
      const open = items.filter((item) => item.status === 'open').length
      setTaskTotals({ open, total: items.length })
    } catch {
      // Non-fatal: leaves the gauge section blank, same treatment as loadDashboard's fetch failure.
    }
  }, [])
```

3. Replace the existing effect:
```tsx
  useEffect(() => {
    loadStatus()
    loadDashboard()
  }, [loadStatus, loadDashboard])
```
with:
```tsx
  useEffect(() => {
    loadStatus()
    loadDashboard()
    loadTaskTotals()
  }, [loadStatus, loadDashboard, loadTaskTotals])
```

4. Insert this block immediately after the closing `</div>` of the two-KPI-card grid (the `grid grid-cols-1 gap-4 sm:grid-cols-2` div), and before the `<Card className="mt-6">` that wraps "Recent activity":

```tsx
          {taskTotals && (
            <Card className="mt-6 flex items-center justify-center p-8">
              <TasksRemainingGauge open={taskTotals.open} total={taskTotals.total} />
            </Card>
          )}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npm --prefix frontend test -- dashboard/page.test.tsx`
Expected: PASS (8/8 tests)

- [ ] **Step 10: Run the full suite and the build**

Run:
```bash
npm --prefix frontend test
npm --prefix frontend run build
```
Expected: all tests pass, static export succeeds.

- [ ] **Step 11: Commit**

```bash
git add frontend/app/globals.css frontend/app/components/TasksRemainingGauge.tsx frontend/app/components/TasksRemainingGauge.test.tsx frontend/app/dashboard/page.tsx frontend/app/dashboard/page.test.tsx
git commit -m "feat: add tasks-remaining gauge to dashboard"
```

---

### Task 6: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete test suite**

Run: `npm --prefix frontend test`
Expected: all test files pass, including `Button.test.tsx`, `NavBar.test.tsx`, `TasksRemainingGauge.test.tsx`, `dashboard/page.test.tsx`, and every other previously-existing test file.

- [ ] **Step 2: Run the linter**

Run: `npm --prefix frontend run lint`
Expected: only 6 pre-existing `react-hooks/set-state-in-effect` / `@typescript-eslint/no-explicit-any` errors, confirmed present on `main` before this phase started, in: `frontend/app/contacts/view/page.tsx`, `frontend/app/dashboard/page.tsx` (this phase edits this file's `useEffect` block in Task 5 — the error's line number will shift, but it's the same pre-existing pattern, not a new one introduced here), `frontend/app/planner/page.tsx`, `frontend/app/search/page.tsx`, and `frontend/lib/api.test.ts` (2 errors). Fixing these is out of scope for this phase. Zero *new* errors from any file touched in this phase.

- [ ] **Step 3: Run the static export build**

Run: `npm --prefix frontend run build`
Expected: build succeeds with no errors.

- [ ] **Step 4: Manual visual check**

Run: `npm --prefix frontend run dev`, open `http://localhost:3000/dashboard` in a browser, and confirm:
- Sidebar shows icons, an animated active-item indicator, a working collapse toggle (persists across a page refresh), and the real connected email + initial in the footer
- Two KPI cards (Contacts, Open action items) with icons
- Tasks-remaining gauge renders with a plausible color zone and the correct open/total label
- Recent activity renders as a timeline with icons
- "Sync now" / "Extract now" buttons still work (trigger the real endpoints)
