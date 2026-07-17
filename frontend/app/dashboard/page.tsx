'use client'

import { useCallback, useEffect, useState } from 'react'

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
  const [status, setStatus] = useState<GraphStatus>({ state: 'loading' })
  const [dashboard, setDashboard] = useState<DashboardData | null>(null)
  const [triggerError, setTriggerError] = useState<string | null>(null)
  const [pending, setPending] = useState<'sync' | 'extract' | null>(null)

  const loadStatus = useCallback(async () => {
    const response = await apiFetch('/api/me/graph-status')

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
  }, [])

  const loadDashboard = useCallback(async () => {
    const response = await apiFetch('/api/dashboard')
    if (!response.ok) return
    setDashboard(await response.json())
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

  if (status.state === 'loading') return <p>Loading…</p>

  if (status.state === 'needs_reauth') {
    return (
      <p>
        Your Microsoft connection expired.{' '}
        <a href="/login">Reconnect your Microsoft account</a>.
      </p>
    )
  }

  if (status.state === 'error') {
    return <p role="alert">Something went wrong loading your account.</p>
  }

  return (
    <div className="p-6">
      <p>Connected as {status.email}</p>

      <div className="mt-4 flex gap-3">
        <button
          onClick={() => runTrigger('sync')}
          disabled={pending !== null}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          Sync now
        </button>
        <button
          onClick={() => runTrigger('extract')}
          disabled={pending !== null}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          Extract now
        </button>
      </div>

      {triggerError && <p role="alert" className="mt-2 text-red-600">{triggerError}</p>}

      {dashboard && (
        <>
          <div className="mt-6 flex gap-6">
            <div>
              <p className="text-2xl">{dashboard.contact_count}</p>
              <p>Contacts</p>
            </div>
            <div>
              <p className="text-2xl">{dashboard.open_action_item_count}</p>
              <p>Open action items</p>
            </div>
          </div>

          <h2 className="mt-6 text-lg">Recent activity</h2>
          {dashboard.activity.length === 0 ? (
            <p>No recent activity.</p>
          ) : (
            <ul className="mt-2">
              {dashboard.activity.map((entry) => (
                <li key={`${entry.type}-${entry.id}`}>
                  {entry.type === 'contact_updated'
                    ? `Updated contact: ${entry.display_name ?? entry.email_address}`
                    : `New action item (${entry.direction}): ${entry.text}`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
