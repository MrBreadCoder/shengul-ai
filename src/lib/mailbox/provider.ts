export interface MailboxTokens {
  accessToken: string
  refreshToken: string
  expiresAt: string // ISO timestamp
}

export interface SendEmailInput {
  to: string
  subject: string
  body: string
}

export interface SendEmailResult {
  providerMessageId: string
  threadId: string
}

export interface ExchangeResult {
  tokens: MailboxTokens
  emailAddress: string
  displayName: string | null
}

export interface MailboxProvider {
  readonly provider: 'gmail' | 'outlook'
  buildAuthUrl(state: string): string
  exchangeCode(code: string): Promise<ExchangeResult>
  // Returns the send result plus (possibly refreshed) tokens to persist.
  sendEmail(
    tokens: MailboxTokens,
    input: SendEmailInput,
  ): Promise<{ result: SendEmailResult; tokens: MailboxTokens }>
}
