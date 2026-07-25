/**
 * Legal pages are prerendered, so this frame is only ever seen on a slow
 * navigation. It mirrors the document layout — date, title, lede, then a run of
 * paragraph lines — so the page does not jump when the copy arrives.
 */
export default function LegalLoading(): React.ReactElement {
  return (
    <div className="landing min-h-[100dvh] bg-[var(--l-bg)]">
      <div className="mx-auto max-w-[46rem] px-4 pt-28">
        <div className="h-2.5 w-32 animate-pulse rounded-full bg-[var(--l-hairline)]" />
        <div className="mt-6 h-10 w-full max-w-[420px] animate-pulse rounded-full bg-[var(--l-hairline-strong)]" />
        <div className="mt-8 flex flex-col gap-3">
          {[0, 1, 2, 3, 4, 5].map((line) => (
            <div
              key={line}
              className="h-3 animate-pulse rounded-full bg-[var(--l-hairline)]"
              style={{ width: `${100 - line * 7}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
