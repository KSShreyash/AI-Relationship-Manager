export const GRAPH_RESOURCE_SCOPES = [
  'User.Read',
  'Mail.Read',
  'Chat.Read',
  'Calendars.ReadWrite',
  'OnlineMeetings.ReadWrite',
]

export const OAUTH_SCOPES = `openid email profile offline_access ${GRAPH_RESOURCE_SCOPES.join(' ')}`
