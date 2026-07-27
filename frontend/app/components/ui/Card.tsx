import type { ReactNode } from 'react'
import clsx from 'clsx'

type CardProps = {
  children: ReactNode
  className?: string
  hoverable?: boolean
}

export function Card({ children, className, hoverable = false }: CardProps) {
  return (
    <div
      className={clsx(
        'rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-surface)] p-6',
        hoverable &&
          'transition-all duration-200 hover:-translate-y-0.5 hover:border-[var(--color-accent)]/60',
        className
      )}
    >
      <div>
        {children}
      </div>
    </div>
  )
}
