import { createClient } from './supabase/client'

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL!
  const supabase = createClient()
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token

  const headers = new Headers(init.headers)
  if (token) {
    headers.set('Authorization', `Bearer ${token}`)
  }

  return fetch(`${apiBaseUrl}${path}`, { ...init, headers })
}
