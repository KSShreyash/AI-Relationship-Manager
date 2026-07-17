<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Vitest fake-timers gotchas

Verified in this repo's installed Vitest/jsdom/user-event versions (see `frontend/app/contacts/page.test.tsx` and `frontend/app/planner/page.test.tsx`):

- `userEvent.click()` / `userEvent.type()` (`@testing-library/user-event`) hang indefinitely once `vi.useFakeTimers()` is active — even on a plain button with no debounce/timers. Use `fireEvent.click(...)` / `fireEvent.change(...)` (`@testing-library/react`) instead in any test that also uses fake timers.
- `waitFor` (`@testing-library/react`) only knows about **Jest's** fake timers, not Vitest's — if `vi.useFakeTimers()` fakes `setTimeout`/`setInterval` (its default), `waitFor` polls via an already-frozen interval and hangs, even with zero user interaction. If a test only needs `vi.setSystemTime()` (e.g. to control "today"), scope the fake explicitly: `vi.useFakeTimers({ toFake: ['Date'] })`. This keeps `Date` mocked while leaving `waitFor` and `fireEvent` working normally.
