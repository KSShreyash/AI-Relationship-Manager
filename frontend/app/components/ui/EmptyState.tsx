import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import clsx from 'clsx'

type EmptyStateProps = {
  icon: LucideIcon
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={clsx('flex flex-col items-center gap-3 py-12 text-center', className)}>
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-surface)] text-[var(--color-muted)]">
        <Icon size={22} aria-hidden="true" />
      </span>
      <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
      {description && <p className="max-w-sm text-sm text-[var(--color-muted)]">{description}</p>}
      {action}
    </div>
  )
}
