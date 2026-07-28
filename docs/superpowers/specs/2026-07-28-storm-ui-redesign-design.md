# Storm UI Redesign Design

## Summary

A second-pass visual redesign of the same app redesigned in
`2026-07-27-enterprise-ui-redesign-design.md`, replacing the charcoal +
neon-green enterprise look with a near-black + indigo/violet "Storm" look,
based on a reference mockup showing Dashboard, Contacts, Planner, and Search
screens.

**This is a visual reskin, not a feature build.** The reference mockup shows
several fields and features the backend has no data for (relationship
score, response rate, avg follow-up time, company/role/department/status on
contacts, a workspace switcher, multi-type search across emails/meetings/
files/notes, an activity heatmap, an AI insights feed, month-over-month
KPI deltas). None of these are added. Where the mockup's layout mechanic
(a table, a tab bar) is adoptable using only real, existing data, we adopt
it; where a mockup element has no real data behind it, it is dropped. No
backend, API, or data-model changes.

## Global Constraints

- Zero backend/API/data-model changes. Verify every adopted UI element
  against an existing endpoint/field before including it.
- All colors via the CSS custom properties in `frontend/app/globals.css`
  (`var(--color-*)`), never hardcoded hex or Tailwind palette classes.
  Tailwind's JIT scanner can't detect dynamically-constructed arbitrary-value
  classes from variables — dynamic colors (chart fills, per-item border
  colors) go through inline `style` props, not Tailwind class strings.
- Existing fetch calls, state machines, POST bodies, and debounce/
  stale-request guards in every touched page must remain byte-for-byte
  unchanged unless a task explicitly says otherwise.

## 1. Color Tokens

Replace the palette in `frontend/app/globals.css`:

| Token | Old | New |
|---|---|---|
| `--color-bg` | `#111315` | `#0A0A0F` |
| `--color-bg-alt` | `#16181D` | `#101015` |
| `--color-surface` | `#1C2027` | `#16161D` |
| `--color-border` | `#2A2F38` | `#26262F` |
| `--color-accent` | `#8CF01F` | `#6D5DFB` |
| `--color-accent-fg` | `#0A0A0A` | `#FFFFFF` |
| `--color-fg` | `#F5F6F7` | `#F5F5F7` |
| `--color-muted` | `#9AA3AE` | `#9497A6` |

Unchanged: `--radius-card` (`18px`), `--color-danger` (`#F87171`),
`--color-danger-border` (`#4A2326`), `--color-danger-surface` (`#2A1214`),
`--color-warning` (`#FBBF24`) — these are semantic, not palette-dependent,
and already read correctly against a darker background.

Because every component reads color exclusively through these vars, this
token swap alone re-themes every page with no other edits required.

## 2. Favicon

Replace `frontend/app/favicon.ico` with the user-supplied `favicon.ico`
currently sitting untracked at the repo root. Next.js App Router serves
`app/favicon.ico` automatically — no other wiring needed.

## 3. Sidebar (`NavBar.tsx`)

- Wordmark unchanged: keep the "AI Relationship Manager" text (no "Storm"
  logo treatment).
- Footer unchanged in content: email only, no "Owner" label, no workspace
  switcher, no notification bell.
- Purely inherits the new color tokens — no structural edit needed beyond
  what token substitution already gives it.
- Dropped from the mockup (no backing feature): notification bell,
  workspace/client switcher ("Airtel"), "AI Insights"/"Reports" sidebar
  section — none of these exist as pages or data sources.

## 4. Dashboard (`dashboard/page.tsx`)

- Keep the two real KPI cards (Contacts, Open action items), restyled in
  the denser icon-card treatment from the mockup.
- **Dropped**: Meetings Scheduled, Emails Processed, Response Rate, Avg
  Follow-up Time KPI cards, and the "+12% from last month" deltas under
  each — none of this is computed or stored anywhere (no historical
  snapshots, no meeting/email counters).
- **New**: "Upcoming tasks" preview card — top 5 open action items sorted
  by nearest `due_date`, reusing the existing `/api/action-items` fetch
  (real data, just a new bounded slice/view of it, not a new endpoint).
- Keep "Recent activity" list as-is, restyled.
- Replace `TasksRemainingGauge` (semicircle arc) with a new
  `TasksRemainingBar` component: a horizontal rounded bar — track in
  `--color-border`, fill animates to `open/total` width — using the exact
  same green/amber/red zone thresholds (`<=0.33` / `0.33–0.66` / `>0.66`)
  and the same `{ open, total }` props, so `dashboard/page.tsx` changes
  only its import/render, not its fetch logic.
- **Dropped**: Activity Heatmap, AI Insights feed — no backing data (same
  call the original 2026-07-27 spec made).

## 5. Contacts (`contacts/page.tsx`)

Convert the current card-list into a real data table:

- Columns: **Contact** (avatar + display name/email), **Open Items**,
  **Last Interaction** — the only fields the `contacts` table and its
  derived `open_action_item_count` actually provide.
- Keep existing search input and Recent/Name sort toggle.
- **Dropped**: Company, Role, Department, Relationship Score, Status,
  Priority columns and filter dropdowns, plus the Import / "+ Add Contact"
  buttons — none of these fields exist on `public.contacts`
  (`email_address`, `display_name`, `notes`, `updated_at` only), and
  contacts are populated exclusively via Microsoft Graph sync, not manual
  entry or import.

## 6. Planner (`planner/page.tsx`)

Replace the direction `<select>` + stacked-groups layout with a tab bar:

- Tabs: **Overdue / Today / Tomorrow / This week / Next week / No date /
  Completed**, each showing a count badge, single active tab shown at a
  time (matches the mockup's selected-tab mechanic).
- Bucketing is pure client-side logic over the existing `due_date` field
  (exhaustive — every item falls into exactly one bucket):
  - Overdue: `daysFromNow(due_date) < 0`
  - Today: `daysFromNow(due_date) == 0`
  - Tomorrow: `daysFromNow(due_date) == 1`
  - This week: `daysFromNow(due_date)` in `[2, 7]`
  - Next week: `daysFromNow(due_date) >= 8` (catch-all for anything further
    out — equivalent coverage to today's "Later" bucket, renamed to match
    the mockup's tab set)
  - No date: `due_date` is `null`
  - Completed: `status === 'done'`
  - Default active tab on load: "Today".
- The existing Mine/Theirs direction filter is kept (it's real, working
  functionality with no mockup equivalent) — restyled and moved to sit
  alongside the tab bar instead of today's dropdown+checkbox row. The
  `includeDone` checkbox is removed since Completed is now its own tab.
- Row content unchanged (checkbox, item text, contact avatar, due-date
  badge, Schedule link), restyled to new tokens.
- Done-toggle checkbox becomes the new enterprise `Checkbox` primitive
  (see section 8).
- **Dropped**: "View Calendar" / "+ Add Task" header buttons (no calendar
  view or manual task-creation endpoint exists), priority badges
  (High/Medium/Low) and category tags (Email/Chat/System/Meeting/Task)
  per row — `ActionItem` has no `priority` or channel/source-type field.

## 7. Search (`search/page.tsx`)

- Tabs: **All / People / Tasks**, mapping to the existing
  `results.contacts` / `results.action_items` arrays — no new search
  categories.
- Results restyled as icon-row cards matching the mockup's result-list
  treatment.
- **New, frontend-only**: "Recent searches" as pills below the search bar,
  persisted to `localStorage` (last 5 distinct non-empty queries, most
  recent first), with a "Clear all" action. No backend involvement.
- **Dropped**: Emails / Meetings / Files / AI Notes tabs — `/api/search`
  only ever returns `contacts` and `action_items`.

## 8. Enterprise Checkbox (new `ui/Checkbox.tsx` primitive)

A visually-hidden native `<input type="checkbox">` (for accessibility)
paired with a styled sibling box, following the same
visually-hidden-input + styled-sibling technique already used for the
online-meeting toggle in `ScheduleActionItemPanel`:

- 18px rounded square (`6px` radius), bordered in `--color-border`.
- Checked: solid `--color-accent` fill with a white checkmark icon
  (`lucide-react`'s `Check`).
- Hover (unchecked): border tints toward `--color-accent`.
- Props: `checked`, `onChange`, `aria-label` — same contract Planner's
  current native checkbox already uses, so the swap is a drop-in
  replacement at the one call site (Planner's done-toggle).

## 9. Schedule Popover (`ScheduleActionItemPanel.tsx`)

Visual restyle only — new tokens, refined spacing/typography to match the
mockup's popover card treatment. **Not adding** Duration / Date / Timezone
dropdowns or "Advanced options" — `/api/action-items/{id}/schedule-suggestions`
returns fixed pre-computed slots; there is nothing for those controls to
actually drive.

## 10. Contact Detail (`contacts/view/page.tsx`)

Token-only reskin. The mockup doesn't depict this screen; no structural
change.

## Out of Scope (explicitly dropped, no backing data/feature)

Relationship score, response rate, avg follow-up time KPIs, company/role/
department/status/priority fields anywhere, workspace/client switcher,
notification bell, Import/Add Contact, View Calendar/Add Task, activity
heatmap, AI Insights feed, Emails/Meetings/Files/AI Notes search
categories, Duration/Date/Timezone/Advanced-options scheduling controls,
month-over-month KPI deltas.
