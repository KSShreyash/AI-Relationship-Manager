'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { apiFetch } from '@/lib/api'

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
        <p className="text-neutral-400">Loading…</p>
      </div>
    )
  }

  if (status.state === 'needs_reauth') {
    return (
      <div className="p-8">
        <p className="text-neutral-300">
          Your Microsoft connection expired.{' '}
          <a href="/login" className="text-emerald-400 hover:underline">
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
        <p role="alert" className="text-red-400">Something went wrong loading your account.</p>
      </div>
    )
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">Dashboard</h1>
          <p className="mt-1 text-sm text-neutral-400">Connected as {status.email}</p>
        </div>

        <div className="flex gap-3">
          <button
            onClick={() => runTrigger('sync')}
            disabled={pending !== null}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-emerald-400 disabled:opacity-50"
          >
            Sync now
          </button>
          <button
            onClick={() => runTrigger('extract')}
            disabled={pending !== null}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-100 transition hover:bg-neutral-800 disabled:opacity-50"
          >
            Extract now
          </button>
        </div>
      </div>

      {triggerError && <p role="alert" className="mt-3 text-sm text-red-400">{triggerError}</p>}

      {dashboard && (
        <>
          <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
              <p className="text-2xl font-semibold text-white">{dashboard.contact_count}</p>
              <p className="mt-1 text-sm text-neutral-400">Contacts</p>
            </div>
            <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-4">
              <p className="text-2xl font-semibold text-white">{dashboard.open_action_item_count}</p>
              <p className="mt-1 text-sm text-neutral-400">Open action items</p>
            </div>
          </div>

          <div className="mt-6 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
            <h2 className="text-sm font-semibold text-white">Recent activity</h2>
            {dashboard.activity.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-400">No recent activity.</p>
            ) : (
              <ul className="mt-2 divide-y divide-neutral-800">
                {dashboard.activity.map((entry) => (
                  <li key={`${entry.type}-${entry.id}`} className="py-2 text-sm text-neutral-300">
                    {entry.type === 'contact_updated'
                      ? `Updated contact: ${entry.display_name ?? entry.email_address}`
                      : `New action item (${entry.direction}): ${entry.text}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}
