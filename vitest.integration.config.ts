import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Integration tests hit a live Supabase project (local `supabase start` or hosted).
// Run with real env loaded, e.g.: `set -a; . ./.env.local; set +a; pnpm test:integration`
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
  },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
})
