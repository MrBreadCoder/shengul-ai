/**
 * The page blocks only on the session lookup, so this is a quiet holding frame
 * rather than a skeleton of the whole composition.
 */
export default function MarketingLoading(): React.ReactElement {
  return (
    <div className="landing min-h-[100dvh] bg-[var(--l-bg)]">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 pt-40">
        <div className="h-3 w-40 animate-pulse rounded-full bg-[var(--l-hairline-strong)]" />
        <div className="h-14 w-full max-w-[640px] animate-pulse rounded-full bg-[var(--l-hairline)]" />
        <div className="h-14 w-full max-w-[420px] animate-pulse rounded-full bg-[var(--l-hairline)]" />
      </div>
    </div>
  )
}
