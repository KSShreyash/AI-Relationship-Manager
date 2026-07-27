# Enterprise UI/UX Redesign — Design Spec

## Goal

Redesign the frontend of the AI Relationship Manager so it reads as a premium
enterprise SaaS product (Notion / Linear / Vercel / Stripe Dashboard tier),
while making zero changes to the backend, API contracts, or data models.
Every visual element must be backed by data the existing API already
returns.

## Global Constraints

- **No backend changes.** No new endpoints, no new columns, no changed
  response shapes. Anything not derivable from an existing endpoint is out
  of scope for this redesign.
- **Static export stays working.** `frontend/next.config.ts` uses
  `output: "export"` with `images: { unoptimized: true }`. No `next/image`
  remote loading, no server-only APIs. Illustrations are hand-built SVG/CSS,
  not hosted images.
- **New dependencies (frontend only), added once in Phase 1:**
  `framer-motion`, `lucide-react`, `clsx`.
- **Color tokens** (Tailwind v4 `@theme` variables in `frontend/app/globals.css`):
  ```
  --color-bg:        #111315
  --color-bg-alt:     #16181D
  --color-surface:    #1C2027
  --color-border:     #2A2F38
  --color-accent:     #8CF01F
  --color-accent-fg:  #0A0A0A   (text/icons drawn on the accent color)
  --color-muted:      #9AA3AE
  --color-fg:         #F5F6F7
  --radius-card:      18px
  ```
  Components consume these tokens exclusively — no hardcoded hex values in
  component files.
- **Typography:** headings 700–800 weight, body 400–500 weight, generous
  section spacing (Tailwind `space-y-*` / `gap-*` at the larger end of the
  scale, not cramped defaults).
- **Motion:** `framer-motion` for card fade+translateY on mount, button
  `scale: 0.98` on tap, hover = slight lift + border glow, all transitions
  ~200ms ease-out. No bounce/spring overshoot anywhere.
- **Accessibility:** every interactive element keyboard-reachable, visible
  focus ring using `--color-accent`, sufficient contrast against the dark
  palette, ARIA labels on icon-only buttons.
- **Testing:** every page carries existing Vitest + Testing Library
  coverage (`*.page.test.tsx`). Redesigns must keep these suites passing —
  update assertions/queries to match new markup, prefer role/text-based
  queries that survive visual changes. Respect the fake-timers gotchas in
  `frontend/AGENTS.md` (use `fireEvent`, not `userEvent`, in any test using
  `vi.useFakeTimers()`).
- **Explicitly dropped** (no backing data, not being added to the backend):
  relationship score, response rate, average follow-up time, activity
  heatmap, AI insights feed, workspace/team switcher, pricing tiers,
  testimonials, "trusted by" logos, department/company/role fields on
  contacts, contact avatar photos (initials avatars used instead — real,
  computed client-side from the name/email already returned).

## Rollout Phases

1. Design system (tokens, shared `components/ui` primitives) + Login/Hero page
2. Sidebar chrome + Dashboard (incl. tasks-remaining gauge)
3. Contacts list + Contact detail page
4. Planner + scheduling popover redesign
5. Search page

Each phase ships as its own reviewable unit before the next starts.

---

## Design System (Phase 1)

**New shared component directory:** `frontend/app/components/ui/`

- `Button.tsx` — variants `primary` (accent bg, `--color-accent-fg` text),
  `secondary` (outline, transparent bg), `ghost` (no border, muted text →
  fg on hover), `danger` (subtle red text/border). All: rounded (`radius`
  token), medium height (`px-4 py-2.5`), `whileTap={{ scale: 0.98 }}` and
  `whileHover` slight lift via `framer-motion`.
- `Card.tsx` — `--color-surface` background, `--color-border` border,
  `radius-card`, padding `p-6`/`p-8`. Optional `hoverable` prop: adds
  border-glow + `translateY(-2px)` on hover, 200ms.
- `Input.tsx` — rounded, `--color-border` border, focus ring in
  `--color-accent`, optional floating/animated label.
- `Badge.tsx` — small pill, variant-colored (accent/muted/danger) for status
  labels (e.g. "Open", "Done", "Overdue").
- `Skeleton.tsx` — pulse-animated placeholder block, used for every loading
  state instead of "Loading…" text.
- `EmptyState.tsx` — icon (from `lucide-react`) + heading + muted
  description + optional CTA button, used whenever a list/collection is
  empty.

**Icons:** `lucide-react`, used consistently for nav items, empty states,
KPI cards, and action buttons — no emoji, no mixed icon styles.

**Page transitions:** a shared `PageTransition` wrapper (`framer-motion`
`AnimatePresence` + fade) applied in `frontend/app/layout.tsx` around
`{children}`.

---

## Login / Hero Page (Phase 1 target)

**File:** `frontend/app/(auth)/login/page.tsx`

Replaces the current bare centered card with a two-column hero (stacks to
one column below `md`):

- **Left column:**
  - Eyebrow label: "AI Relationship Intelligence"
  - Headline (800 weight, large): "Stop Losing Relationships. Let AI Manage
    Every Conversation."
  - Subheading (muted, 400 weight): explains the real product — AI extracts
    action items from your emails and meetings, tracks commitments, and
    schedules follow-ups automatically.
  - Three feature bullets, each with a `lucide-react` icon: "Extracts
    action items from email & calendar," "Tracks who owes who what," "Books
    follow-ups directly on your calendar."
  - Primary CTA button: "Sign in with Microsoft" (same
    `supabase.auth.signInWithOAuth` call as today — **no logic change**,
    styling only).
- **Right column:** a hand-built SVG/CSS illustration of the real workflow:
  `Email → AI Analysis → Action Items → Follow-up`, styled as connected
  cards/nodes with the accent color, animated with a subtle staggered
  fade-in on mount (`framer-motion`). No stock photos, no fake product
  screenshot.
- Background: subtle radial gradient from `--color-bg` to `--color-bg-alt`,
  no loud color.

**Test impact:** `frontend/app/(auth)/login/page.test.tsx` currently
asserts on the sign-in button and its click handler — update queries to
match new markup (e.g. `getByRole('button', { name: /sign in with
microsoft/i })`), behavior under test is unchanged.

---

## Sidebar + Dashboard (Phase 2)

**Sidebar** (`frontend/app/components/NavBar.tsx`):

- Nav items get `lucide-react` icons (Dashboard, Contacts, Planner, Search).
- Active item: rounded accent-tinted background + left accent bar, animated
  slide/highlight between items on navigation (`framer-motion`
  `layoutId`).
- Footer: real user identity — fetch `/api/me/graph-status` (already used
  by the Dashboard page; reused here, not a new endpoint) to show an
  initials avatar + connected email, plus the existing "Sign out" action.
  No workspace switcher (single-user app, nothing to switch between).
- Collapse toggle: icon-only rail state, persisted in `localStorage`,
  animated width transition.

**Dashboard** (`frontend/app/dashboard/page.tsx`), data from `/api/dashboard`
plus one additional call to `/api/action-items?include_done=true` (existing
endpoint, reused) for the gauge:

- **KPI cards row:** "Contacts" (`contact_count`), "Open action items"
  (`open_action_item_count`) — each a `Card` with icon, large number, and a
  short static description (no fake trend arrows, since no historical data
  exists to compute a trend from).
- **Tasks-remaining gauge:** a radial/speedometer gauge (custom SVG arc,
  no charting library needed for a single arc) plotting `open` against
  `total = open + done` fetched from `/api/action-items?include_done=true`.
  Needle/arc position = `open / total`. Color zones by that ratio: **green**
  `<= 0.33`, **amber** `0.33–0.66`, **red** `> 0.66`. Center label: "`{open}`
  open of `{total}` total". Empty state (`total === 0`): render the gauge at
  0 in the green zone with the label "No tasks yet."
- **Recent activity:** re-styled as a vertical timeline (icon per event
  type — contact vs. action item — from `lucide-react`, timestamp, short
  description) using the exact same `activity` array `/api/dashboard`
  returns today. No invented fields.
- **Sync controls:** the existing "Sync now" / "Extract now" buttons,
  restyled with the new `Button` component — same handlers, same
  `/api/sync/run/me` and `/api/extraction/run/me` calls.

**Test impact:** `frontend/app/dashboard/page.test.tsx` will need a mock
for the new `/api/action-items?include_done=true` call; keep existing
mocks for `/api/dashboard` and `/api/me/graph-status`.

---

## Contacts + Contact Detail (Phase 3)

**Contacts list** (`frontend/app/contacts/page.tsx`), data from
`/api/contacts`:

- Each contact becomes a `Card` row: initials avatar — first letters of the
  first two words of `display_name` if present (e.g. "Jane Doe" → "JD"),
  otherwise the first letter of `email_address` before the `@` — name,
  email, open-action-item count
  as a `Badge`, "last updated" (from `updated_at`, relative time e.g. "3d
  ago" computed client-side). Hover reveals an "Open" action.
- Search input restyled with the `Input` component — same debounced fetch
  logic.
- Sorting: alphabetical or by `updated_at` (both computable client-side
  from data already returned) — no "most active"/"highest priority"
  sorting since no such field exists.
- Empty state via `EmptyState` component: "No contacts yet — sync and
  extract to get started."

**Contact detail** (`frontend/app/contacts/view/page.tsx`), data from
`/api/contacts/{id}` and `/api/contacts/{id}/action-items`:

- Profile header: initials avatar, name, email, "member since"
  (`created_at`).
- Notes rendered as an "AI summary" card (the `notes` field is exactly
  that — no new field needed).
- Open / Done action items as two grouped lists using the redesigned list
  item style, `ScheduleActionItemPanel` restyled to match (see Phase 4).

---

## Planner + Scheduling Popover (Phase 4)

**Planner** (`frontend/app/planner/page.tsx`):

- Existing groups (Overdue, Due this week, Later, No due date, Completed)
  restyled as sectioned card lists with status-colored left borders
  (overdue = red tint, due this week = accent tint).
- Each item: checkbox-style done toggle, title, contact name/avatar,
  due-date badge — all from data already returned by `/api/action-items`.
  `source_type` (already in the API response) rendered as a small badge
  ("email" / "calendar" / "manual").

**Scheduling popover** (`frontend/app/components/ScheduleActionItemPanel.tsx`):

- Replace the inline `<ul>` of links with a floating popover panel (opens
  from the "Schedule" button), built with plain positioned `framer-motion`
  animation (fade + scale-in, 200ms) — no new dependency needed for this
  since it's a single anchored panel, not a complex menu.
- Slots (from `/api/action-items/{id}/schedule-suggestions`, unchanged)
  rendered as a responsive grid of rounded time-slot chips instead of a
  vertical list. Selected state = accent fill. Disabled/submitting state
  dims the grid.
- Online-meeting checkbox restyled as a toggle switch.
- **Not building:** duration selection (30/45/60/90 min) or timezone
  display — the backend only returns fixed-length suggested slots
  (`start`/`end` pairs) with no duration parameter or timezone field in the
  response, so there is nothing to wire a duration/timezone control to
  without a backend change.

---

## Search (Phase 5)

**File:** `frontend/app/search/page.tsx`

- Large search input at top (restyled `Input`), same debounced
  `/api/search` call.
- Results grouped exactly as today — "Contacts" and "Action Items"
  sections — restyled as card lists matching the Contacts/Planner visual
  language. Matched query term highlighted client-side (simple substring
  wrap, no backend change).
- Empty/idle state via `EmptyState`: "Type to search your contacts and
  action items."
- **Not building:** filter chips for Emails/Meetings/Files/AI Notes,
  keyboard navigation between results, or recent/suggested searches — none
  of that is backed by the current `/api/search` response (`contacts` +
  `action_items` only) or any client-side-storable equivalent that was
  requested/approved.

---

## Out of Scope (confirmed with user)

- Marketing landing page at `/` — root stays the existing redirect stub;
  the Login page absorbs the hero/marketing role instead.
- Any KPI, badge, or filter requiring data the API doesn't return (see
  Global Constraints' dropped list).
- Workspace switcher, team members, pricing, testimonials, "trusted by"
  logos — this is a single-user app with no team/billing concept.
- Backend/API/schema changes of any kind.
