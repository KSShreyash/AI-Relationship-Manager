import type { ReactNode } from 'react'
import clsx from 'clsx'

export type BadgeVariant = 'accent' | 'muted' | 'danger'

type BadgeProps = {
  children: ReactNode
  variant?: BadgeVariant
  className?: string
}

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  accent: 'bg-[var(--color-accent)]/10 text-[var(--color-accent)]',
  muted: 'border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)]',
  danger: 'bg-[var(--color-danger-surface)] text-[var(--color-danger)]',
}

export function Badge({ children, variant = 'muted', className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        VARIANT_CLASSES[variant],
        className
      )}
    >
      {children}
    </span>
  )
}
