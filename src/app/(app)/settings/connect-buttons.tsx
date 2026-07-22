export function ConnectButtons() {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <a href="/api/mailboxes/google/connect">
        <button type="button">Connect Gmail</button>
      </a>
      <a href="/api/mailboxes/outlook/connect">
        <button type="button">Connect Outlook</button>
      </a>
    </div>
  )
}
