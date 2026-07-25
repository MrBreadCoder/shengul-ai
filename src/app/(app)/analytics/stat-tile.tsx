interface StatTileProps {
  label: string
  value: string
  hint?: string
  /** Position in its grid, used only to stagger the entrance animation. */
  index?: number
}

// Caps the stagger so a tile far down a long grid never waits noticeably
// longer than one at the top — the reveal should read as "together," not "in order."
const MAX_STAGGER_STEPS = 8
const STAGGER_STEP_MS = 40

export function StatTile({ label, value, hint, index }: StatTileProps): React.ReactElement {
  const style =
    index !== undefined ? { animationDelay: `${Math.min(index, MAX_STAGGER_STEPS) * STAGGER_STEP_MS}ms` } : undefined

  return (
    <div
      className="border-hairline bg-surface card-interactive animate-rise min-w-0 rounded-lg border p-4"
      style={style}
    >
      <p className="text-muted-foreground truncate text-xs">{label}</p>
      <p className="tnum mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      {hint ? <p className="text-faint mt-1 text-[11px] leading-snug">{hint}</p> : null}
    </div>
  )
}
