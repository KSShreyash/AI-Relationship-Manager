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
