'use client'

import { useEffect, useState } from 'react'

import { apiFetch } from '@/lib/api'

type GraphStatus =
  | { state: 'loading' }
  | { state: 'connected'; email: string }
  | { state: 'needs_reauth' }
  | { state: 'error' }

export default function DashboardPage() {
  const [status, setStatus] = useState<GraphStatus>({ state: 'loading' })

  useEffect(() => {
    async function loadStatus() {
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
    }

    loadStatus()
  }, [])

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

  return <p>Connected as {status.email}</p>
}
