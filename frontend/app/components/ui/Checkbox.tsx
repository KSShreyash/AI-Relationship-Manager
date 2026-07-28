import { Check } from 'lucide-react'

type CheckboxProps = {
  checked: boolean
  onChange: () => void
  'aria-label': string
}

export function Checkbox({ checked, onChange, 'aria-label': ariaLabel }: CheckboxProps) {
  return (
    <label className="group relative inline-flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={ariaLabel}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className="absolute inset-0 rounded-[6px] border border-[var(--color-border)] bg-transparent transition peer-checked:border-[var(--color-accent)] peer-checked:bg-[var(--color-accent)] group-hover:border-[var(--color-accent)]"
      />
      <Check
        size={14}
        strokeWidth={3}
        aria-hidden="true"
        className="relative opacity-0 text-[var(--color-accent-fg)] transition peer-checked:opacity-100"
      />
    </label>
  )
}
