# Storm Redesign Phase 2: Contacts Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the Contacts page from a stacked card list into a real data table, matching the Storm mockup's table mechanic while showing only fields the backend actually provides.

**Architecture:** `frontend/app/contacts/page.tsx` keeps its existing fetch/search/sort logic entirely as-is; only the JSX that renders `sortedContacts` changes, from a `<div className="space-y-3">` of `Card` rows to a bordered `<table>` with `Contact` / `Open Items` / `Last Interaction` columns. No new components, no backend changes.

**Tech Stack:** Next.js 16 (App Router), React, TypeScript, Tailwind CSS v4, Vitest + Testing Library.

## Global Constraints

- Zero backend/API/data-model changes.
- All colors via `var(--color-*)` CSS custom properties — never hardcoded hex or Tailwind palette classes.
- The existing fetch/debounce/stale-request-guard logic (the `useEffect` with `setTimeout`, `requestId` ref, 401 redirect, error handling) must remain byte-for-byte unchanged. Only the JSX inside the final `return` that renders `sortedContacts` changes.
- Table columns are exactly **Contact**, **Open Items**, **Last Interaction** — no Company, Role, Department, Relationship Score, Status, or Priority columns/filters, and no Import / "+ Add Contact" buttons, since none of those fields or actions exist in the backend (`public.contacts` has only `email_address`, `display_name`, `notes`, `updated_at`, plus the derived `open_action_item_count`).
- Full spec: `docs/superpowers/specs/2026-07-28-storm-ui-redesign-design.md` (§5).

---

### Task 1: Contacts — card list to data table

**Files:**
- Modify: `frontend/app/contacts/page.tsx`
- Modify: `frontend/app/contacts/page.test.tsx`

**Interfaces:**
- Consumes: `getInitials` (`frontend/lib/getInitials.ts`), `formatRelativeTime` (`frontend/lib/formatRelativeTime.ts`), `Badge` (`frontend/app/components/ui/Badge.tsx`) — all already imported and used by the current file, unchanged signatures.
- Produces: nothing consumed by a later phase — Contacts is a leaf page in this redesign.

The current file (for reference — do not retype the whole file, only replace the section shown in Step 3) fetches contacts into `sortedContacts: Contact[] | null` and, when non-null and non-empty, renders each contact as a `Card` row inside a `<div className="mt-4 space-y-3">`. This task replaces only that block.

- [ ] **Step 1: Write the failing test**

Add this test to `frontend/app/contacts/page.test.tsx`, as a new `it` block inside the existing `describe('ContactsPage', ...)` (place it right after the `'renders contacts with their open action item count and a working link'` test):

```tsx
  it('renders contacts as a data table with Contact, Open Items, and Last Interaction columns', async () => {
    apiFetchMock.mockResolvedValue(
      jsonResponse([
        { id: '1', email_address: 'alice@example.com', display_name: 'Alice', open_action_item_count: 2, updated_at: '2026-07-17T10:00:00Z' },
      ])
    )

    render(<ContactsPage />)

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(screen.getByRole('columnheader', { name: 'Contact' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Open Items' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Last Interaction' })).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run app/contacts/page.test.tsx -t "renders contacts as a data table"`
Expected: FAIL — `Unable to find an accessible element with the role "table"` (the current markup is a `<div>` of cards, no `<table>` exists yet).

- [ ] **Step 3: Replace the card-list rendering with a table**

In `frontend/app/contacts/page.tsx`, remove the `Card` import (no longer used on this page):

```tsx
import { Card } from '@/app/components/ui/Card'
```

Replace this entire block (the `<div className="mt-4 space-y-3">...</div>` that maps over `sortedContacts`):

```tsx
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
```

with:

```tsx
        <div className="mt-4 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border)]">
          <table className="w-full text-left">
            <thead className="bg-[var(--color-bg-alt)]">
              <tr>
                <th scope="col" className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  Contact
                </th>
                <th scope="col" className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  Open Items
                </th>
                <th scope="col" className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-muted)]">
                  Last Interaction
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {sortedContacts.map((contact) => (
                <tr key={contact.id} className="bg-[var(--color-surface)] transition hover:bg-[var(--color-bg-alt)]">
                  <td className="px-4 py-3">
                    <a
                      href={`/contacts/view?id=${contact.id}`}
                      aria-label={contact.display_name ?? contact.email_address ?? undefined}
                      className="flex items-center gap-3"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-alt)] text-xs font-semibold text-[var(--color-accent)]">
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
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={contact.open_action_item_count > 0 ? 'accent' : 'muted'}>
                      {contact.open_action_item_count} open
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--color-muted)]">
                    {formatRelativeTime(contact.updated_at, new Date())}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
```

Note: the bordered/rounded wrapper is a plain `<div>`, not the `Card` component — `Card` bakes in `p-6` padding via its own fixed class string, which would fight with the table's own cell padding and isn't reliably overridable through a passed-in `className` (Tailwind's utility precedence isn't class-attribute-order-based). Building the border/radius/background directly with the same tokens `Card` uses avoids that conflict.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run app/contacts/page.test.tsx`
Expected: PASS, all tests in the file — including the pre-existing ones. Specifically confirm:
- `'renders contacts with their open action item count and a working link'` still passes (the link keeps its explicit `aria-label`, and `'2 open'` text is unchanged, just now inside a `<td>` instead of a `Card`).
- `'sorts by recency by default...'` still passes (`getAllByRole('link')` still returns one link per row, in DOM order, which a `<table>`'s row order preserves identically to the old `<div>` list).
- `'debounces search input...'` still passes (unrelated to markup — it only asserts fetch call counts and text presence).

- [ ] **Step 5: Run the full suite to confirm no other regressions**

Run: `cd frontend && npx vitest run`
Expected: all test files pass.

- [ ] **Step 6: Commit**

```bash
git add frontend/app/contacts/page.tsx frontend/app/contacts/page.test.tsx
git commit -m "feat: render Contacts as a data table instead of stacked cards"
```

---

## Phase 2 Verification

- [ ] Run the full suite once more: `cd frontend && npx vitest run`
- [ ] Run the project's lint command in `frontend/` and confirm zero new errors.
- [ ] Start the dev server and visually confirm: Contacts now renders as a bordered table with Contact/Open Items/Last Interaction columns, search and Recent/Name sorting still work, clicking a row's name still navigates to that contact's detail page.
