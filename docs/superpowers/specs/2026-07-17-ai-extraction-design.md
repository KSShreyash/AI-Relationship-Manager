# AI Extraction — Design Spec

**Date:** 2026-07-17
**Sub-project 3 of 6** in the AI Relationship Manager platform (Foundation → Graph Sync → **AI Extraction** → Contact Profiles/Dashboard/Planner → AI Scheduler → Global Search).

## Context

Graph Sync (sub-project 2) is live: a user's Outlook mail, calendar, and Teams chat are synced into `emails`, `calendar_events`, and `chat_messages` in Postgres, incrementally, via delta-query (mail/calendar) and timestamp-polling (chat). Nothing has been done with that content yet beyond storing it — `body_text` on mail/calendar even still holds raw HTML from Graph, unstripped.

This spec covers turning that raw synced content into structured, useful data: who the user interacts with (contacts) and what commitments exist between them (action items), extracted via an LLM. Later sub-projects (Contact Profiles/Dashboard/Planner) render this data; this sub-project only produces it.

## Goals

- Identify contacts (people the user emails, meets, or chats with) and maintain a running, LLM-synthesized summary of relationship facts about each.
- Extract action items/commitments from mail, calendar events, and chat messages, tagged with direction (things the user owes others vs. things others owe the user), status, due date, and source.
- Process content per-item, incrementally, as it's synced — not in large batches.
- Both automatic (triggered right after Graph Sync) and on-demand ("Extract now") triggering.

## Non-goals (explicitly deferred)

Contact profile UI/dashboard rendering, a task/planner UI for action items, merging or manually reconciling "Contacts without email" entries with real contacts, semantic search over extracted content (Global Search, sub-project 6), any AI-driven scheduling action (AI Scheduler, sub-project 5), filtering out automated/newsletter senders before extraction (explicitly rejected — process everything).

## Architecture

```
sync_user() (Graph Sync, unchanged trigger surface: cron / on-demand sync /
post-connect) already runs for every connected user via three paths.
extract_user() is called from inside sync_user() itself, right after its
three resource syncs finish — so extraction automatically rides along on
all three of Graph Sync's existing triggers for free, with a per-run cap.

This sub-project adds exactly ONE new trigger surface: a dedicated
on-demand extraction endpoint, for re-extracting without forcing a full
Graph sync first.

  - POST /api/extraction/run/me (JWT-authenticated, uncapped, synchronous)
     |
     v
[Render: FastAPI backend — app/services/ai_extraction.py]
  extract_user(pool, user_id, limit: int | None) -> None
     |  scans emails/calendar_events/chat_messages for extracted_at IS NULL,
     |  oldest first, up to `limit` rows (None = unbounded, used by the
     |  on-demand endpoint; sync_user()'s call passes a fixed cap instead —
     |  see Key Decisions Log for the number)
     v
[OpenAI API: gpt-4o-mini, structured outputs]  -->  [Supabase Postgres: contacts, action_items]
```

- New service file `app/services/ai_extraction.py`, structurally parallel to `graph_sync.py` — same layering (repositories → service → endpoint). Not embedded inside `sync_mail`/`sync_calendar`/`sync_chat`, so a slow/failing OpenAI call never blocks or degrades sync itself.
- Content sent to OpenAI is HTML-stripped first — mail/calendar `body_text` currently stores raw Graph HTML; this is the point where that finally gets handled.
- Participant identity is resolved from Graph's already-synced structured fields (`from_address`, `organizer`/`attendees`, `from_user`) **before** calling the LLM — the LLM only interprets content, never decides who's in the conversation. Lower hallucination risk, and keeps contact identity deterministic.

## Data Model

RLS posture matches every Graph Sync table: enabled, zero policies, service-role-only access (defense-in-depth; primary access path is FastAPI's service-role connection). These tables become user-facing once Contact Profiles/Dashboard reads them (sub-project 4), but this stage keeps the same default.

### `contacts`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | |
| `user_id` | uuid, FK → `profiles.id` | |
| `email_address` | text, nullable | identity key when known (mail/calendar) |
| `display_name` | text, nullable | identity key when `email_address` is null (chat-only contacts — the "Contacts without email" case) |
| `notes` | text, nullable | freeform running summary; the LLM rewrites/extends this each time new content involving the contact is processed, given the previous notes as context — not a raw append log |
| `created_at`, `updated_at` | timestamptz | |
| unique (partial) | `(user_id, email_address) WHERE email_address IS NOT NULL` | normal email-keyed contacts dedupe by email |
| unique (partial) | `(user_id, display_name) WHERE email_address IS NULL` | chat-only contacts dedupe by display name instead, so repeated messages from the same person reuse one row |

**Known tradeoff:** Graph's chat message payload (`from.user`) only provides a display name, not an email — resolving to a real email would need an additional `/users/{id}` Graph call, not done here. Chat-sourced contacts therefore match by display name alone, which risks collisions (two different people sharing a display name would incorrectly merge into one "no email" contact). Accepted as strictly better than dropping the information; reconciling/splitting these is natural work for the Contact Profiles sub-project. "Contacts without email" as a UI concept is just a query filter (`WHERE email_address IS NULL`), not separate storage.

### `action_items`
| column | type | notes |
|---|---|---|
| `id` | uuid, PK | |
| `user_id` | uuid, FK → `profiles.id` | |
| `contact_id` | uuid, FK → `contacts.id`, nullable | the other party, when resolved (see Architecture) |
| `text` | text | the commitment/task itself |
| `direction` | enum: `mine`, `theirs` | who owes whom |
| `status` | enum: `open`, `done` | default `open` |
| `due_date` | date, nullable | extracted/inferred if mentioned in the content |
| `source_type` | enum: `email`, `calendar_event`, `chat_message` | |
| `source_id` | uuid | the row's `id` in the relevant source table; polymorphic — not a DB-enforced FK (Postgres can't FK across three tables), integrity kept at the application layer |
| `created_at` | timestamptz | |

### Modifications to existing Graph Sync tables
`emails`, `calendar_events`, `chat_messages` each get one new nullable column:

| column | type | notes |
|---|---|---|
| `extracted_at` | timestamptz, nullable | the "has this row been processed by extraction yet" cursor — same role as `sync_state` but per-row, since extraction is inherently per-item, not per-resource-type |

## Extraction Mechanics

`extract_user(pool, user_id, limit: int | None) -> None`:

1. Query unprocessed rows across all three source tables (`WHERE extracted_at IS NULL`), oldest-first, up to `limit` (`None` when called from the on-demand endpoint).
2. For each item, resolve participant(s) purely from Graph-synced structured fields (never the LLM):
   - Email: `from_address` → look up/create a `contacts` row keyed by email.
   - Calendar event: `organizer` + each `attendees` entry → same, one contact per email.
   - Chat message: `from_user` (display name) → look up/create a `contacts` row keyed by display name (`email_address IS NULL`).
3. Fetch each resolved contact's current `notes` (if any); strip HTML from the item's body content.
4. Call OpenAI once (structured output / JSON schema mode, `gpt-4o-mini`) with: the stripped content, and each known participant's identity + current notes. Request back: an updated `notes` string per participant (LLM-synthesized, not a raw append) and a list of action items (`text`, `direction`, `due_date`, which participant it relates to).
5. **Atomically**, in one Postgres transaction per item: upsert each contact's new `notes`, insert the action items, set `extracted_at = now()` on the source row. Any failure inside the transaction rolls back everything for that item — it stays unprocessed and retries next run, and this also prevents duplicate `action_items` from ever landing on a retry.
6. **Per-item isolation:** if one item's OpenAI call or transaction fails for any reason, log it, leave `extracted_at` null, continue to the next item. One bad item never blocks or aborts the batch — this is deliberately built in from the start, mirroring a gap Graph Sync's `sync_chat` had to be fixed for after its final review.

## Error Handling

- **OpenAI 429 / transient 5xx:** honor `Retry-After` if present, retry once; if still failing, leave the item unprocessed for the next run — no infinite retry loops. Same shape as Graph Sync's `_get_json` helper.
- **Malformed structured output:** treated as a per-item failure (logged, left unprocessed, loop continues) — JSON schema mode should make this rare, but it's not assumed impossible.
- **Missing/invalid `OPENAI_API_KEY`:** fails fast at startup, same pattern as `SYNC_SECRET`/`FERNET_KEY`.
- **Partial batch failure:** fully covered by per-item isolation + per-item transactions; no separate handling needed.
- **On-demand endpoint:** uncapped and synchronous, but the same per-item isolation applies — one bad item doesn't abort the rest of that user's pending queue.

## Testing Strategy

- Participant resolution: email-based lookup/creation for mail/calendar; display-name-based lookup/creation for chat; reuse (not duplicate) on a second item from the same contact.
- HTML-stripping on mail/calendar body content before it reaches the LLM.
- Mocked-OpenAI unit tests: a structured response correctly produces an updated contact `notes`, correctly-tagged `action_items` (`direction`/`due_date`/`source_type`/`source_id`), and a stamped `extracted_at` — all inside one transaction.
- Per-item isolation: one item's OpenAI call raising doesn't stop the batch; that item stays unprocessed, later items still get processed.
- Capped vs. uncapped: the automatic path respects `limit`; the on-demand path processes everything pending regardless of count.
- "Contacts without email" partial-unique-index behavior: two chat messages from the same display name reuse one contact row; two different display names create two separate no-email contacts.
- Manual acceptance: run on-demand extraction against real synced data (the personal Microsoft account already verified live in Graph Sync), confirm `contacts` and `action_items` populate and read plausibly.

## Key Decisions Log

- **Both contacts and action items, not just one** — broader scope than a minimal first cut, but both are needed to feed the next sub-project's dashboard/planner meaningfully.
- **OpenAI (`gpt-4o-mini`), structured outputs** — matches the original roadmap's "OpenAI extraction" naming; JSON schema mode over free-text parsing for reliability.
- **Per-item, incremental processing** — not batched-per-contact. Simpler cost model (proportional to new content only), easier to reason about, consistent with Graph Sync's own per-item upsert pattern.
- **Automatic (capped at `EXTRACTION_BATCH_LIMIT = 50` items per call) + on-demand (uncapped)** — the automatic path stays bounded per run so a large backfill doesn't cause one slow/expensive sync cycle (leftovers just get picked up on the next ~15-minute cron tick, same pattern as Graph Sync's delta pagination); the on-demand path (`limit=None`) processes everything pending, since a user explicitly asking for it expects it to fully complete.
- **Process everything, no automated-sender filtering** — simpler pipeline; relies on the LLM/prompt to produce nothing meaningful for non-human senders rather than pre-filtering with heuristics that could get it wrong.
- **Contact identity: email address when available, display name when not** — not full LLM-assisted fuzzy matching. Deterministic and simple, at the cost of the known "Contacts without email" name-collision tradeoff (see Data Model).
- **Participants resolved from Graph metadata, not the LLM** — the LLM's job is strictly content interpretation; who's in the conversation is already known and reliable from what Graph Sync already stored.
- **Per-item transactions + per-item isolation, built in from the start** — a direct lesson carried forward from Graph Sync's final review, where the equivalent gaps (`sync_chat`'s per-chat isolation, `sync_user`'s per-resource isolation) had to be retrofitted after the fact.
