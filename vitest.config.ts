import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    // *.integration.test.ts requires a live Supabase project (local `supabase start`
    // or hosted) and is run separately via `pnpm test:integration`.
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
    // Stub values so importing `@/lib/env` (module-scope `loadEnv(process.env)`)
    // never crashes a unit test. Never real secrets — just satisfies the schema shape.
    env: {
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
      APP_URL: 'http://localhost:3000',
      GOOGLE_OAUTH_CLIENT_ID: 'test-google-client-id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'test-google-client-secret',
      MICROSOFT_OAUTH_CLIENT_ID: 'test-microsoft-client-id',
      MICROSOFT_OAUTH_CLIENT_SECRET: 'test-microsoft-client-secret',
      MAILBOX_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      QSTASH_TOKEN: 'test-qstash-token',
      QSTASH_CURRENT_SIGNING_KEY: 'test-qstash-current-signing-key',
      QSTASH_NEXT_SIGNING_KEY: 'test-qstash-next-signing-key',
      BRIGHTDATA_API_KEY: 'test-brightdata-api-key',
      BRIGHTDATA_SCRAPE_ZONE: 'test-web-unlocker-zone',
      GEMINI_API_KEY: 'test-gemini-api-key',
      APOLLO_API_KEY: 'test-apollo-api-key',
      EMAILABLE_API_KEY: 'test-emailable-api-key',
    },
  },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
})
