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
            AI Assistant reads your emails and meetings, extracts what you
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
