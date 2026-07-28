type TasksRemainingBarProps = {
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

export function TasksRemainingBar({ open, total }: TasksRemainingBarProps) {
  const ratio = total > 0 ? open / total : 0
  const percentage = Math.min(100, Math.max(0, ratio * 100))
  const color = zoneColor(ratio)

  return (
    <div className="w-full max-w-[320px]">
      <p className="text-lg font-bold text-[var(--color-fg)]">
        {total === 0 ? 'No tasks yet' : `${open} open of ${total} total`}
      </p>
      <div
        role="img"
        aria-label={`${open} open of ${total} total tasks`}
        className="mt-3 h-3 w-full overflow-hidden rounded-full bg-[var(--color-border)]"
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${percentage}%`,
            backgroundColor: color,
            transition: 'width 0.2s ease-out, background-color 0.2s ease-out',
          }}
        />
      </div>
    </div>
  )
}
