export function getInitials(displayName: string | null, email: string | null): string {
  if (displayName) {
    const words = displayName.trim().split(/\s+/).slice(0, 2)
    return words.map((word) => word.charAt(0).toUpperCase()).join('')
  }
  if (email) return email.charAt(0).toUpperCase()
  return '?'
}
