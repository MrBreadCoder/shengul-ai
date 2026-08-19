'use client'

// Catches a throw in the root `layout.tsx` itself — the one place `error.tsx`
// can never reach, since error.tsx is rendered *by* that layout. Next only
// mounts this file when everything above it (including next-intl's provider,
// which lives inside the root layout) may be broken, so this stays static,
// dependency-free English rather than risking a second crash while trying to
// translate the first one. It must render its own <html>/<body> — it fully
// replaces the root layout when active.
export default function GlobalError({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <html lang="en">
      <body>
        <div
          role="alert"
          style={{
            display: 'flex',
            minHeight: '100dvh',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '12px',
            padding: '24px',
            textAlign: 'center',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <p style={{ fontSize: '15px', fontWeight: 500 }}>Something went wrong</p>
          <p style={{ fontSize: '13px', color: '#888', maxWidth: '52ch' }}>
            This page could not be loaded. Nothing was lost — try again.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '8px',
              padding: '8px 16px',
              borderRadius: '8px',
              border: '1px solid #888',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            Retry
          </button>
        </div>
      </body>
    </html>
  )
}
