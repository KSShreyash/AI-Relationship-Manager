type TasksRemainingGaugeProps = {
  open: number
  total: number
}

const GREEN_MAX_RATIO = 0.33
const AMBER_MAX_RATIO = 0.66

function zoneColor(ratio: number): string {
  if (ratio <= GREEN_MAX_RATIO) return 'var(--color-accent)'
  if (ratio <= AMBER_MAX_RATIO) return 'var(--color-warning)'
  return 'var(--color-danger)'
}

export function TasksRemainingGauge({ open, total }: TasksRemainingGaugeProps) {
  const ratio = total > 0 ? open / total : 0
  const percentage = Math.min(100, Math.max(0, ratio * 100))
  const color = zoneColor(ratio)

  return (
    <div className="flex flex-col items-center">
      <svg
        viewBox="0 0 200 110"
        className="w-full max-w-[220px]"
        role="img"
        aria-label={`${open} open of ${total} total tasks`}
      >
        <path
          d="M 10 100 A 90 90 0 0 1 190 100"
          fill="none"
          stroke="var(--color-border)"
          strokeWidth="16"
          strokeLinecap="round"
        />
        <path
          d="M 10 100 A 90 90 0 0 1 190 100"
          fill="none"
          stroke={color}
          strokeWidth="16"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={100}
          strokeDashoffset={100 - percentage}
          style={{ transition: 'stroke-dashoffset 0.2s ease-out, stroke 0.2s ease-out' }}
        />
      </svg>
      <p className="-mt-4 text-lg font-bold text-[var(--color-fg)]">
        {total === 0 ? 'No tasks yet' : `${open} open of ${total} total`}
      </p>
    </div>
  )
}
