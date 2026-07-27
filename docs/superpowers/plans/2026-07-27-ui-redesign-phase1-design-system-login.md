# UI Redesign Phase 1: Design System + Login/Hero Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the shared design-token/component foundation and redesign the login page into a premium marketing hero, with zero backend/API/data-model changes.

**Architecture:** Add three small frontend dependencies (`framer-motion`, `lucide-react`, `clsx`), define the enterprise color palette as CSS custom properties consumed via Tailwind v4 arbitrary values, build two reusable primitives (`Button`, `Card`) plus a page-fade wrapper, then rebuild `frontend/app/(auth)/login/page.tsx` on top of them without touching its `signInWithOAuth` logic.

**Tech Stack:** Next.js 16 (App Router, static export), React 19, TypeScript, Tailwind CSS v4, Vitest + Testing Library, `framer-motion`, `lucide-react`, `clsx`.

## Global Constraints

- No backend changes. No new endpoints, no changed response shapes.
- Static export must keep working (`output: "export"`, `images: { unoptimized: true }` in `frontend/next.config.ts`) — no `next/image` remote loading, no hand-rolled `<img>` pointing at external hosts.
- Color tokens (define once in `frontend/app/globals.css`, consume everywhere via `var(--color-*)`):
  ```
  --color-bg:        #111315
  --color-bg-alt:     #16181D
  --color-surface:    #1C2027
  --color-border:     #2A2F38
  --color-accent:     #8CF01F
  --color-accent-fg:  #0A0A0A
  --color-muted:      #9AA3AE
  --color-fg:         #F5F6F7
  --radius-card:      18px
  ```
- Motion: `framer-motion`, ~200ms ease-out transitions, buttons scale to `0.98` on tap, hover = slight lift, no bounce/spring overshoot.
- Only these three new dependencies for this phase: `framer-motion`, `lucide-react`, `clsx`. Do not add a component framework (Radix/shadcn) in this phase.
- Keep `frontend/app/(auth)/login/page.tsx`'s `handleSignIn` function and its `supabase.auth.signInWithOAuth` call byte-for-byte behaviorally identical — this task is styling only.
- Every task's tests must pass with `npm --prefix frontend test` before moving to the next task.
- Follow `frontend/AGENTS.md`: use `fireEvent`, not `userEvent`, in any test — this codebase's existing tests all use `fireEvent`, and mixing in `userEvent` causes hangs under fake timers elsewhere in the suite.

---

### Task 1: Install dependencies and define design tokens

**Files:**
- Modify: `frontend/package.json` (via `npm install`, not hand-edited)
- Modify: `frontend/app/globals.css`

**Interfaces:**
- Produces: CSS custom properties `--color-bg`, `--color-bg-alt`, `--color-surface`, `--color-border`, `--color-accent`, `--color-accent-fg`, `--color-muted`, `--color-fg`, `--radius-card` on `:root`, available to every component via `var(--color-accent)` etc.

- [ ] **Step 1: Install the three new dependencies**

Run (from the `frontend` directory):
```bash
npm install framer-motion lucide-react clsx
```
Expected: `package.json` gains `framer-motion`, `lucide-react`, and `clsx` under `"dependencies"`, and `package-lock.json` updates. No errors.

- [ ] **Step 2: Add the design tokens to `globals.css`**

Replace the full contents of `frontend/app/globals.css` with:

```css
@import "tailwindcss";

:root {
  --background: #0a0a0a;
  --foreground: #ededed;

  --color-bg: #111315;
  --color-bg-alt: #16181D;
  --color-surface: #1C2027;
  --color-border: #2A2F38;
  --color-accent: #8CF01F;
  --color-accent-fg: #0A0A0A;
  --color-muted: #9AA3AE;
  --color-fg: #F5F6F7;
  --radius-card: 18px;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --font-mono: var(--font-geist-mono);
}

body {
  background: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans), Arial, Helvetica, sans-serif;
}
```

This only adds new custom properties — the existing `--background`/`--foreground`/`@theme inline`/`body` block are unchanged, so nothing else in the app can regress from this step.

- [ ] **Step 3: Verify nothing broke**

Run:
```bash
npm --prefix frontend test
npm --prefix frontend run build
```
Expected: both commands succeed (test suite green, static export completes) — this step touches no component logic, only adds unused-so-far CSS variables and dependencies.

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/app/globals.css
git commit -m "chore: add design-system dependencies and color tokens"
```

---

### Task 2: Build the `Button` primitive

**Files:**
- Create: `frontend/app/components/ui/Button.tsx`
- Test: `frontend/app/components/ui/Button.test.tsx`

**Interfaces:**
- Consumes: `clsx` (from `clsx`), `motion` (from `framer-motion`).
- Produces: named export `Button` from `frontend/app/components/ui/Button.tsx`, typed as:
  ```ts
  type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
  type ButtonProps = {
    variant?: ButtonVariant
    className?: string
    children: ReactNode
    onClick?: () => void
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
  }
  function Button(props: ButtonProps): JSX.Element
  ```
  Default `variant` is `'primary'`. Later tasks (Task 5, and Phase 2+) import this as `import { Button } from '@/app/components/ui/Button'`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/components/ui/Button.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { Button } from './Button'

describe('Button', () => {
  it('renders its children', () => {
    render(<Button>Click me</Button>)
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument()
  })

  it('calls onClick when clicked', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Click me</Button>)
    fireEvent.click(screen.getByRole('button', { name: 'Click me' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('does not call onClick when disabled', () => {
    const onClick = vi.fn()
    render(
      <Button onClick={onClick} disabled>
        Click me
      </Button>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Click me' }))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('applies the danger variant class', () => {
    render(<Button variant="danger">Delete</Button>)
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('text-red-400')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend test -- Button.test.tsx`
Expected: FAIL — `Cannot find module './Button'` (or similar resolution error), since `Button.tsx` doesn't exist yet.

- [ ] **Step 3: Implement `Button`**

Create `frontend/app/components/ui/Button.tsx`:

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
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:brightness-110',
  secondary:
    'border border-[var(--color-border)] bg-transparent text-[var(--color-fg)] hover:border-[var(--color-accent)]',
  ghost: 'text-[var(--color-muted)] hover:text-[var(--color-fg)]',
  danger: 'border border-red-900/60 text-red-400 hover:bg-red-950/40',
}

export function Button({
  variant = 'primary',
  className,
  children,
  onClick,
  type = 'button',
  disabled = false,
}: ButtonProps) {
  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled}
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
Expected: PASS (4/4 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/ui/Button.tsx frontend/app/components/ui/Button.test.tsx
git commit -m "feat: add shared Button primitive"
```

---

### Task 3: Build the `Card` primitive

**Files:**
- Create: `frontend/app/components/ui/Card.tsx`
- Test: `frontend/app/components/ui/Card.test.tsx`

**Interfaces:**
- Consumes: `clsx` (from `clsx`).
- Produces: named export `Card` from `frontend/app/components/ui/Card.tsx`, typed as:
  ```ts
  type CardProps = { children: ReactNode; className?: string; hoverable?: boolean }
  function Card(props: CardProps): JSX.Element
  ```
  Consumed by Task 5 (login hero workflow tiles) and, in later phases, by Dashboard/Contacts/Planner/Search.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/components/ui/Card.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Card } from './Card'

describe('Card', () => {
  it('renders its children inside a bordered surface', () => {
    render(<Card>Contents</Card>)
    const card = screen.getByText('Contents').parentElement
    expect(card).toHaveClass('border-[var(--color-border)]')
    expect(card).toHaveClass('bg-[var(--color-surface)]')
  })

  it('adds hover-lift classes only when hoverable is true', () => {
    render(<Card>Plain</Card>)
    expect(screen.getByText('Plain').parentElement).not.toHaveClass('hover:-translate-y-0.5')

    render(<Card hoverable>Hoverable</Card>)
    expect(screen.getByText('Hoverable').parentElement).toHaveClass('hover:-translate-y-0.5')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend test -- Card.test.tsx`
Expected: FAIL — `Cannot find module './Card'`

- [ ] **Step 3: Implement `Card`**

Create `frontend/app/components/ui/Card.tsx`:

```tsx
import type { ReactNode } from 'react'
import clsx from 'clsx'

type CardProps = {
  children: ReactNode
  className?: string
  hoverable?: boolean
}

export function Card({ children, className, hoverable = false }: CardProps) {
  return (
    <div
      className={clsx(
        'rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6',
        hoverable &&
          'transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--color-accent)]/60',
        className
      )}
    >
      {children}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix frontend test -- Card.test.tsx`
Expected: PASS (2/2 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/app/components/ui/Card.tsx frontend/app/components/ui/Card.test.tsx
git commit -m "feat: add shared Card primitive"
```

---

### Task 4: Build `PageTransition` and wire it into the root layout

**Files:**
- Create: `frontend/app/components/PageTransition.tsx`
- Test: `frontend/app/components/PageTransition.test.tsx`
- Modify: `frontend/app/layout.tsx`

**Interfaces:**
- Consumes: `usePathname` (from `next/navigation`), `AnimatePresence`/`motion` (from `framer-motion`).
- Produces: named export `PageTransition` from `frontend/app/components/PageTransition.tsx`, typed as `function PageTransition({ children }: { children: ReactNode }): JSX.Element`. Wraps the `{children}` slot in `frontend/app/layout.tsx`.

- [ ] **Step 1: Write the failing test**

Create `frontend/app/components/PageTransition.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
}))

import { PageTransition } from './PageTransition'

describe('PageTransition', () => {
  it('renders its children', () => {
    render(
      <PageTransition>
        <p>Page content</p>
      </PageTransition>
    )
    expect(screen.getByText('Page content')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix frontend test -- PageTransition.test.tsx`
Expected: FAIL — `Cannot find module './PageTransition'`

- [ ] **Step 3: Implement `PageTransition`**

Create `frontend/app/components/PageTransition.tsx`:

```tsx
'use client'

import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { usePathname } from 'next/navigation'

export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname()

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={pathname}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix frontend test -- PageTransition.test.tsx`
Expected: PASS (1/1 test)

- [ ] **Step 5: Wire `PageTransition` into the root layout**

Replace the contents of `frontend/app/layout.tsx` with:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import NavBar from "./components/NavBar";
import { PageTransition } from "./components/PageTransition";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Relationship Manager",
  description: "Stay on top of your contacts and follow-ups.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full bg-neutral-950 text-neutral-100">
        <NavBar />
        <div className="min-w-0 flex-1">
          <PageTransition>{children}</PageTransition>
        </div>
      </body>
    </html>
  );
}
```

- [ ] **Step 6: Run the full suite and build to confirm the layout change didn't break existing pages**

Run:
```bash
npm --prefix frontend test
npm --prefix frontend run build
```
Expected: all existing tests still PASS, static export still succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/app/components/PageTransition.tsx frontend/app/components/PageTransition.test.tsx frontend/app/layout.tsx
git commit -m "feat: add page-fade transition wrapper to root layout"
```

---

### Task 5: Redesign the Login/Hero page

**Files:**
- Modify: `frontend/app/(auth)/login/page.tsx`
- Modify: `frontend/app/(auth)/login/page.test.tsx`

**Interfaces:**
- Consumes: `Button` from `frontend/app/components/ui/Button.tsx` (Task 2), `Card` from `frontend/app/components/ui/Card.tsx` (Task 3), existing `createClient` from `@/lib/supabase/client`, existing `OAUTH_SCOPES` from `@/lib/graph-scopes`, icons from `lucide-react`, `motion` from `framer-motion`.
- Produces: same default export `LoginPage`, same `handleSignIn` behavior — no interface change for other files that reference this route.

- [ ] **Step 1: Write the failing test (extend the existing file)**

Replace the full contents of `frontend/app/(auth)/login/page.test.tsx` with:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const signInWithOAuthMock = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signInWithOAuth: signInWithOAuthMock } }),
}))

import LoginPage from './page'

describe('LoginPage', () => {
  beforeEach(() => {
    signInWithOAuthMock.mockReset()
  })

  it('starts the Microsoft OAuth flow with the required Graph scopes on click', () => {
    render(<LoginPage />)

    fireEvent.click(screen.getByRole('button', { name: /sign in with microsoft/i }))

    expect(signInWithOAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'azure',
        options: expect.objectContaining({
          scopes: expect.stringContaining('Mail.Read'),
          redirectTo: expect.stringContaining('/callback'),
        }),
      })
    )
  })

  it('renders the hero headline and feature bullets', () => {
    render(<LoginPage />)

    expect(
      screen.getByRole('heading', { name: /stop losing relationships/i })
    ).toBeInTheDocument()
    expect(screen.getByText(/extracts action items from email & calendar/i)).toBeInTheDocument()
    expect(screen.getByText(/tracks who owes who what/i)).toBeInTheDocument()
    expect(screen.getByText(/books follow-ups directly on your calendar/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify the new test fails**

Run: `npm --prefix frontend test -- "app/(auth)/login/page.test.tsx"`
Expected: first test PASSES (existing behavior untouched so far), second test FAILS — no heading matching "stop losing relationships" exists yet in the current bare-card markup.

- [ ] **Step 3: Implement the redesigned Login/Hero page**

Replace the full contents of `frontend/app/(auth)/login/page.tsx` with:

```tsx
'use client'

import { CalendarClock, ListChecks, Mail, Sparkles } from 'lucide-react'
import { motion } from 'framer-motion'

import { createClient } from '@/lib/supabase/client'
import { OAUTH_SCOPES } from '@/lib/graph-scopes'
import { Button } from '@/app/components/ui/Button'
import { Card } from '@/app/components/ui/Card'

const FEATURES = [
  { icon: Mail, text: 'Extracts action items from email & calendar' },
  { icon: ListChecks, text: 'Tracks who owes who what' },
  { icon: CalendarClock, text: 'Books follow-ups directly on your calendar' },
]

const WORKFLOW = [
  { icon: Mail, label: 'Email' },
  { icon: Sparkles, label: 'AI Analysis' },
  { icon: ListChecks, label: 'Action Items' },
  { icon: CalendarClock, label: 'Follow-up' },
]

export default function LoginPage() {
  async function handleSignIn() {
    const supabase = createClient()
    await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        scopes: OAUTH_SCOPES,
        redirectTo: `${window.location.origin}/callback`,
      },
    })
  }

  return (
    <main className="relative flex min-h-screen items-center overflow-hidden bg-[var(--color-bg)] px-6 py-16 sm:px-12">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(circle at 20% 20%, var(--color-bg-alt), var(--color-bg) 60%)',
        }}
      />

      <div className="mx-auto grid w-full max-w-6xl gap-16 md:grid-cols-2 md:items-center">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-[var(--color-accent)]">
            AI Relationship Intelligence
          </p>
          <h1 className="mt-4 text-4xl font-extrabold leading-tight text-[var(--color-fg)] sm:text-5xl">
            Stop Losing Relationships. Let AI Manage Every Conversation.
          </h1>
          <p className="mt-6 max-w-md text-base text-[var(--color-muted)]">
            AI Relationship Manager reads your emails and meetings, extracts what you
            committed to, and schedules the follow-up before it slips.
          </p>

          <ul className="mt-8 space-y-4">
            {FEATURES.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-[var(--color-fg)]">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-accent)]">
                  <Icon size={16} aria-hidden="true" />
                </span>
                {text}
              </li>
            ))}
          </ul>

          <Button className="mt-10" onClick={handleSignIn}>
            Sign in with Microsoft
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {WORKFLOW.map(({ icon: Icon, label }, index) => (
            <motion.div
              key={label}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: index * 0.1, ease: 'easeOut' }}
            >
              <Card className="flex flex-col items-center gap-3 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
                  <Icon size={20} aria-hidden="true" />
                </span>
                <span className="text-sm font-medium text-[var(--color-fg)]">{label}</span>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>
    </main>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix frontend test -- "app/(auth)/login/page.test.tsx"`
Expected: PASS (2/2 tests)

- [ ] **Step 5: Commit**

```bash
git add "frontend/app/(auth)/login/page.tsx" "frontend/app/(auth)/login/page.test.tsx"
git commit -m "feat: redesign login page as marketing hero"
```

---

### Task 6: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete test suite**

Run: `npm --prefix frontend test`
Expected: all test files PASS, including `Button.test.tsx`, `Card.test.tsx`, `PageTransition.test.tsx`, `(auth)/login/page.test.tsx`, and every previously-existing test file (dashboard, contacts, planner, search, callback, ScheduleActionItemPanel).

- [ ] **Step 2: Run the linter**

Run: `npm --prefix frontend run lint`
Expected: no errors.

- [ ] **Step 3: Run the static export build**

Run: `npm --prefix frontend run build`
Expected: build succeeds with no errors (confirms `output: "export"` still works with the new client components and `framer-motion`/`lucide-react`).

- [ ] **Step 4: Manual visual check**

Run: `npm --prefix frontend run dev`, open `http://localhost:3000/login` in a browser, and confirm:
- Two-column hero layout (stacks to one column on narrow widths)
- Headline, subheading, three feature bullets with icons
- Four animated workflow tiles fade/slide in on load
- "Sign in with Microsoft" button has hover lift and click-scale feedback
- Clicking the button still triggers the real Microsoft OAuth redirect
