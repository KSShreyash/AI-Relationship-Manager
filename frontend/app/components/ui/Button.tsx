'use client'

import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import clsx from 'clsx'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

type ButtonProps = {
  variant?: ButtonVariant
  className?: string
  children: ReactNode
  onClick?: () => void
  type?: 'button' | 'submit' | 'reset'
  disabled?: boolean
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:brightness-110',
  secondary:
    'border border-[var(--color-border)] bg-transparent text-[var(--color-fg)] hover:border-[var(--color-accent)]',
  ghost: 'text-[var(--color-muted)] hover:text-[var(--color-fg)]',
  danger: 'border border-red-900/60 text-red-400 hover:bg-red-950/40',
}

export function Button({
  variant = 'primary',
  className,
  children,
  onClick,
  type = 'button',
  disabled = false,
}: ButtonProps) {
  return (
    <motion.button
      type={type}
      onClick={onClick}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.98 }}
      whileHover={disabled ? undefined : { y: -1 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius-card)] px-4 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:opacity-50 disabled:pointer-events-none',
        VARIANT_CLASSES[variant],
        className
      )}
    >
      {children}
    </motion.button>
  )
}
