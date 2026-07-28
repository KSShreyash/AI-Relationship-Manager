# Storm Redesign Phase 1: Foundation + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-theme the app to the near-black + indigo/violet "Storm" palette, swap in the new favicon, and update the Dashboard page (bar-fill tasks-remaining indicator + a new "Upcoming tasks" preview card).

**Architecture:** Because every existing component already reads color exclusively through the CSS custom properties in `frontend/app/globals.css`, changing the token values re-themes the whole app in one file. This phase also fixes the one place that doesn't use tokens (`layout.tsx`'s hardcoded `bg-neutral-950`), swaps the favicon asset, replaces the semicircle-arc `TasksRemainingGauge` with a horizontal bar-fill `TasksRemainingBar` (same props, same zone-color thresholds), and extends the Dashboard's existing action-items fetch to also power a new "Upcoming tasks" card — no new endpoint, no new fetch call.

**Tech Stack:** Next.js 16 (App Router), React, TypeScript, Tailwind CSS v4, Vitest + Testing Library.

## Global Constraints

- Zero backend/API/data-model changes.
- All colors via `var(--color-*)` CSS custom properties — never hardcoded hex or Tailwind palette classes (e.g. `bg-neutral-950`). Dynamic colors (computed at render time, not a fixed class) go through inline `style` props, not Tailwind arbitrary-value classes, because Tailwind's JIT scanner can't see dynamically-constructed class strings.
- Existing fetch calls, state machines, and request-guard logic in every touched page must remain byte-for-byte unchanged unless a task explicitly says otherwise.
- Full spec: `docs/superpowers/specs/2026-07-28-storm-ui-redesign-design.md`.

---

### Task 1: Color tokens, favicon, and the one hardcoded-color straggler

**Files:**
- Modify: `frontend/app/globals.css`
- Modify: `frontend/app/layout.tsx:32`
- Modify (binary asset swap): `frontend/app/favicon.ico`

**Interfaces:**
- Produces: the new token values every later task (and every existing component) reads via `var(--color-bg)`, `var(--color-bg-alt)`, `var(--color-surface)`, `var(--color-border)`, `var(--color-accent)`, `var(--color-accent-fg)`, `var(--color-fg)`, `var(--color-muted)`. Names are unchanged from before — only the hex values change — so no other file needs to reference a different variable name.

This task has no new logic to unit-test (it's CSS custom-property values plus one Tailwind class swap on a static element), so instead of a TDD red/green cycle, verify with the existing test suite (must stay green — a value-only change can't break any assertion, since no test in the repo asserts a literal hex value; verified by grep) and a visual check.

- [ ] **Step 1: Update the color tokens in `globals.css`**

Open `frontend/app/globals.css` and replace the `:root` block's token values (keep every variable name identical — only values change):

```css
:root {
  --background: #0a0a0a;
  --foreground: #ededed;

  --color-bg: #0A0A0F;
  --color-bg-alt: #101015;
  --color-surface: #16161D;
  --color-border: #26262F;
  --color-accent: #6D5DFB;
  --color-accent-fg: #FFFFFF;
  --color-muted: #9497A6;
  --color-fg: #F5F5F7;
  --radius-card: 18px;
  --color-danger: #F87171;
  --color-danger-border: #4A2326;
  --color-danger-surface: #2A1214;
  --color-warning: #FBBF24;
}
```

(`--background`, `--foreground`, `--radius-card`, and the danger/warning tokens are unchanged — only `--color-bg`, `--color-bg-alt`, `--color-surface`, `--color-border`, `--color-accent`, `--color-accent-fg`, `--color-muted`, `--color-fg` get new values.)

- [ ] **Step 2: Fix `layout.tsx`'s hardcoded body colors to use tokens**

`frontend/app/layout.tsx:32` currently reads:

```tsx
      <body className="flex min-h-full bg-neutral-950 text-neutral-100">
```

Replace with:

```tsx
      <body className="flex min-h-full bg-[var(--color-bg)] text-[var(--color-fg)]">
```

- [ ] **Step 3: Swap in the new favicon**

The repo root has an untracked `favicon.ico` (user-supplied) that must replace `frontend/app/favicon.ico`. Since `Write`/`Edit` tools can't copy binary files, use a shell copy:

```bash
cp "favicon.ico" "frontend/app/favicon.ico"
```

Run this from the repo root (`C:\Drive D\Yolex Labs\AI Scheduler`). Verify the file changed size/content:

```bash
ls -la frontend/app/favicon.ico
```

Expected: file size differs from the previous `25931` bytes (the old favicon), confirming the copy took effect.

- [ ] **Step 4: Run the full frontend test suite to confirm nothing broke**

Run: `cd frontend && npx vitest run`
Expected: all existing tests still pass (this step changes CSS values and one static class string only — no test in the repo asserts a literal hex value or the `neutral-950`/`neutral-100` classes, so a regression here would indicate an unexpected coupling worth investigating, not an expected diff).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/globals.css frontend/app/layout.tsx frontend/app/favicon.ico
git commit -m "feat: re-theme to Storm color palette, fix layout token drift, swap favicon"
```

---

### Task 2: `TasksRemainingBar` component

**Files:**
- Create: `frontend/app/components/TasksRemainingBar.tsx`
- Create: `frontend/app/components/TasksRemainingBar.test.tsx`

**Interfaces:**
- Consumes: nothing new (pure presentational component, same shape as the `TasksRemainingGauge` it replaces).
- Produces: `TasksRemainingBar({ open: number; total: number })` — a named export, same prop names/types as `TasksRemainingGauge` (`open`, `total`), so Task 3 can swap the import with no prop changes. Renders a `role="img"` element with `aria-label` `"${open} open of ${total} total tasks"` (identical wording to the old gauge) and a text label `"${open} open of ${total} total"` (or `"No tasks yet"` when `total === 0`) — identical copy to the old gauge so Task 3's dashboard integration and its existing tests (which assert on this exact text) don't need to change.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/components/TasksRemainingBar.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TasksRemainingBar } from './TasksRemainingBar'

describe('TasksRemainingBar', () => {
  it('shows "No tasks yet" when total is 0', () => {
    render(<TasksRemainingBar open={0} total={0} />)
    expect(screen.getByText('No tasks yet')).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '0 open of 0 total tasks')
  })

  it('shows the open/total label', () => {
    render(<TasksRemainingBar open={2} total={10} />)
    expect(screen.getByText('2 open of 10 total')).toBeInTheDocument()
  })

  it('sizes the fill bar to the open ratio', () => {
    render(<TasksRemainingBar open={3} total={10} />)
    const fill = screen.getByRole('img').firstChild as HTMLElement
    expect(fill.style.width).toBe('30%')
  })

  it('uses the green zone color when the open ratio is 0.33 or below', () => {
    render(<TasksRemainingBar open={3} total={10} />)
    const fill = screen.getByRole('img').firstChild as HTMLElement
    expect(fill.style.backgroundColor).toBe('var(--color-accent)')
  })

  it('uses the amber zone color when the open ratio is between 0.33 and 0.66', () => {
    render(<TasksRemainingBar open={5} total={10} />)
    const fill = screen.getByRole('img').firstChild as HTMLElement
    expect(fill.style.backgroundColor).toBe('var(--color-warning)')
  })

  it('uses the red zone color when the open ratio is above 0.66', () => {
    render(<TasksRemainingBar open={8} total={10} />)
    const fill = screen.getByRole('img').firstChild as HTMLElement
    expect(fill.style.backgroundColor).toBe('var(--color-danger)')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run app/components/TasksRemainingBar.test.tsx`
Expected: FAIL — `Cannot find module './TasksRemainingBar'`

- [ ] **Step 3: Write the implementation**

Create `frontend/app/components/TasksRemainingBar.tsx`:

```tsx
type TasksRemainingBarProps = {
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

export function TasksRemainingBar({ open, total }: TasksRemainingBarProps) {
  const ratio = total > 0 ? open / total : 0
  const percentage = Math.min(100, Math.max(0, ratio * 100))
  const color = zoneColor(ratio)

  return (
    <div className="w-full max-w-[320px]">
      <p className="text-lg font-bold text-[var(--color-fg)]">
        {total === 0 ? 'No tasks yet' : `${open} open of ${total} total`}
      </p>
      <div
        role="img"
        aria-label={`${open} open of ${total} total tasks`}
        className="mt-3 h-3 w-full overflow-hidden rounded-full bg-[var(--color-border)]"
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${percentage}%`,
            backgroundColor: color,
            transition: 'width 0.2s ease-out, background-color 0.2s ease-out',
          }}
        />
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run app/components/TasksRemainingBar.test.tsx`
Expected: PASS (6/6)

- [ ] **Step 5: Delete the old gauge component and its test**

The gauge is fully replaced — no other file imports `TasksRemainingGauge` outside `dashboard/page.tsx`, which Task 3 updates.

```bash
rm frontend/app/components/TasksRemainingGauge.tsx frontend/app/components/TasksRemainingGauge.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add frontend/app/components/TasksRemainingBar.tsx frontend/app/components/TasksRemainingBar.test.tsx
git rm frontend/app/components/TasksRemainingGauge.tsx frontend/app/components/TasksRemainingGauge.test.tsx
git commit -m "feat: replace TasksRemainingGauge with a bar-fill TasksRemainingBar"
```

---

### Task 3: Dashboard — swap in the bar, add an "Upcoming tasks" preview card

**Files:**
- Modify: `frontend/app/dashboard/page.tsx`
- Modify: `frontend/app/dashboard/page.test.tsx`

**Interfaces:**
- Consumes: `TasksRemainingBar` from Task 2 (`import { TasksRemainingBar } from '@/app/components/TasksRemainingBar'`), same `{ open, total }` props the removed `TasksRemainingGauge` took.
- Produces: nothing consumed by a later task in this phase.

The existing `loadTaskTotals` fetch (`/api/action-items?include_done=true`) already returns full action-item objects (`id`, `text`, `direction`, `status`, `due_date`, `contact`) per the backend's `_serialize` — confirmed by reading `backend/app/api/v1/action_items.py`. Today the dashboard only reads `.status` off each item and discards the rest. This task widens the local type to keep `text`, `due_date`, and `contact`, and derives a 5-item "upcoming tasks" list from the same response — no new fetch, no new endpoint.

- [ ] **Step 1: Write the failing test**

Add to `frontend/app/dashboard/page.test.tsx` (insert as a new `it` block inside the existing `describe('DashboardPage', ...)`, after the `'shows the tasks-remaining gauge...'` test — reuse the file's existing `ACTION_ITEMS_BODY` fixture by extending it in-place, since the "gauge" test and this new test read the same fetch mock):

First, replace the existing `ACTION_ITEMS_BODY` constant (near the top of the file) with a version carrying the extra fields the real endpoint always returns:

```ts
const ACTION_ITEMS_BODY = [
  { id: 'i1', status: 'open', text: 'Send the proposal', due_date: '2026-07-20', contact: null },
  { id: 'i2', status: 'open', text: 'Confirm the migration', due_date: '2026-07-18', contact: null },
  { id: 'i3', status: 'done', text: 'Already done', due_date: '2026-07-01', contact: null },
]
```

Then add the new test:

```tsx
  it('shows an upcoming-tasks preview sorted by nearest due date', async () => {
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

    await waitFor(() => expect(screen.getByText('Upcoming tasks')).toBeInTheDocument())
    const list = screen.getByText('Upcoming tasks').closest('div') as HTMLElement
    const items = within(list).getAllByText(/Send the proposal|Confirm the migration|Already done/)
    expect(items.map((el) => el.textContent)).toEqual(['Confirm the migration', 'Send the proposal'])
  })
```

Add `within` to the existing `@testing-library/react` import at the top of the file:

```ts
import { render, screen, waitFor, within } from '@testing-library/react'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run app/dashboard/page.test.tsx -t "upcoming-tasks preview"`
Expected: FAIL — `Unable to find an element with the text: Upcoming tasks`

- [ ] **Step 3: Implement the upcoming-tasks derivation and card in `dashboard/page.tsx`**

Replace the `TasksRemainingGauge` import:

```tsx
import { TasksRemainingGauge } from '@/app/components/TasksRemainingGauge'
```

with:

```tsx
import { TasksRemainingBar } from '@/app/components/TasksRemainingBar'
```

Add a type for the widened action-item shape, near the existing `DashboardData` type:

```tsx
type ActionItemSummary = {
  id: string
  text: string
  status: 'open' | 'done'
  due_date: string | null
  contact: { id: string; display_name: string | null; email_address: string | null } | null
}
```

Replace the `taskTotals` state and `loadTaskTotals` callback:

```tsx
  const [taskTotals, setTaskTotals] = useState<{ open: number; total: number } | null>(null)
```

with:

```tsx
  const [taskTotals, setTaskTotals] = useState<{ open: number; total: number } | null>(null)
  const [upcomingTasks, setUpcomingTasks] = useState<ActionItemSummary[] | null>(null)
```

and replace the body of `loadTaskTotals`:

```tsx
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

with:

```tsx
  const loadTaskTotals = useCallback(async () => {
    try {
      const response = await apiFetch('/api/action-items?include_done=true')
      if (!response.ok) return
      const items: ActionItemSummary[] = await response.json()
      const open = items.filter((item) => item.status === 'open').length
      setTaskTotals({ open, total: items.length })
      const upcoming = items
        .filter((item): item is ActionItemSummary & { due_date: string } => item.status === 'open' && item.due_date !== null)
        .sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())
        .slice(0, 5)
      setUpcomingTasks(upcoming)
    } catch {
      // Non-fatal: leaves the gauge and upcoming-tasks sections blank, same treatment as loadDashboard's fetch failure.
    }
  }, [])
```

Replace the gauge's `Card`:

```tsx
          {taskTotals && (
            <Card className="mt-6 flex items-center justify-center p-8">
              <TasksRemainingGauge open={taskTotals.open} total={taskTotals.total} />
            </Card>
          )}
```

with:

```tsx
          {taskTotals && (
            <Card className="mt-6 flex items-center justify-center p-8">
              <TasksRemainingBar open={taskTotals.open} total={taskTotals.total} />
            </Card>
          )}
```

Finally, add the "Upcoming tasks" card as a sibling to the existing "Recent activity" card, wrapping both in a two-column grid on wide screens. Replace:

```tsx
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
```

with:

```tsx
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card>
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

            {upcomingTasks && (
              <Card>
                <h2 className="text-sm font-semibold text-[var(--color-fg)]">Upcoming tasks</h2>
                {upcomingTasks.length === 0 ? (
                  <p className="mt-2 text-sm text-[var(--color-muted)]">No upcoming tasks.</p>
                ) : (
                  <ul className="mt-4 space-y-4">
                    {upcomingTasks.map((item) => (
                      <li key={item.id} className="flex items-center justify-between gap-3 text-sm">
                        <p className="min-w-0 truncate text-[var(--color-fg)]">{item.text}</p>
                        <span className="shrink-0 text-xs text-[var(--color-muted)]">
                          {new Date(item.due_date + 'T00:00:00Z').toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            )}
          </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run app/dashboard/page.test.tsx`
Expected: PASS, all tests in the file (including the pre-existing ones — the widened `ACTION_ITEMS_BODY` fixture is a superset of the old one, so the "shows the tasks-remaining gauge" test's assertion on `'2 open of 3 total'` still holds: 2 open items among 3 total).

- [ ] **Step 5: Commit**

```bash
git add frontend/app/dashboard/page.tsx frontend/app/dashboard/page.test.tsx
git commit -m "feat: swap dashboard to TasksRemainingBar and add an upcoming-tasks card"
```

---

## Phase 1 Verification

- [ ] Run the full suite once more: `cd frontend && npx vitest run`
- [ ] Run `npm run lint` (or the project's equivalent) in `frontend/` and confirm zero new errors.
- [ ] Start the dev server and visually confirm: the whole app (sidebar, dashboard, contacts, planner, search, contact detail) now renders in the near-black/indigo palette; the favicon in the browser tab is the new one; the Dashboard's tasks-remaining indicator is a horizontal bar, not an arc; an "Upcoming tasks" card appears beside "Recent activity".
