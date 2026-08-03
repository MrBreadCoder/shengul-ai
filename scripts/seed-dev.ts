// Seeds a dev account plus a full set of realistic fake data so every page in
// the app renders as it would in production.
//
//   pnpm seed:dev                 # seed (refuses to run if data already exists)
//   pnpm seed:dev --reset         # wipe all rows in these tables, then seed
//   pnpm seed:dev --additive      # keep existing rows, add a new fake client alongside them
//   pnpm seed:dev --dry-run       # generate + print the summary, write nothing
//   pnpm seed:dev --seed=123      # different dataset from the same generator
//   pnpm seed:dev --password=…    # override the well-known default seed-account password
//
// Uses the service-role key, so it bypasses RLS. Local only — never point this
// at a database whose contents you care about: --reset is unconditional, and
// the default password is a well-known constant checked into this repo. Any
// target that isn't the local Supabase CLI instance (127.0.0.1/localhost)
// requires --i-am-sure to run at all. --additive never deletes anything, but
// it still creates real auth users and fake rows in whatever DB you point it at.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod/v3';
import type { Database } from '../src/types/database'
import { AppError } from '../src/lib/errors/app-error'
import { generateSeedData, type SeedDataset } from '../src/lib/seed/generate'

const DEFAULT_SEED = 20260721
const DEFAULT_PASSWORD = 'devpassword123'
const OPERATOR_EMAIL = 'dev@aib2b.test'
const CLIENT_EMAIL = 'client@aib2b.test'
// PostgREST rejects very large payloads; 500 rows per statement stays well under.
const BATCH_SIZE = 500
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

type TableName = keyof Database['public']['Tables']

// Reverse dependency order. `events` and `app_users` are listed explicitly
// rather than relying on the cascade from `clients`: cron events carry a null
// client_id and would otherwise survive the wipe.
// `satisfies` rather than a `readonly TableName[]` annotation: the annotation
// widened this to every table in the schema, so the `.neq('id', ...)` filter
// below had to type-check against tables that are not listed here — and broke
// the moment one without an `id` column (invite_links) was added. Rows in the
// tables left out cascade from `clients`.
const TABLES_IN_DELETE_ORDER = [
  'events', 'suppressions', 'knowledge_requests', 'sequences', 'emails',
  'case_knowledge', 'leads', 'cases', 'campaigns', 'mailboxes', 'app_users', 'clients',
] as const satisfies readonly TableName[]

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
})

const argsSchema = z.object({
  reset: z.boolean(),
  additive: z.boolean(),
  dryRun: z.boolean(),
  iAmSure: z.boolean(),
  seed: z.number().int(),
  password: z.string().min(6),
}).refine((args) => !(args.reset && args.additive), {
  message: '--reset and --additive are mutually exclusive',
})

type Args = z.infer<typeof argsSchema>

function parseArgs(argv: readonly string[]): Args {
  const flags = new Set(argv.filter((arg) => !arg.includes('=')))
  const values = new Map(
    argv
      .filter((arg) => arg.includes('='))
      .map((arg) => {
        const separator = arg.indexOf('=')
        return [arg.slice(0, separator), arg.slice(separator + 1)] as const
      }),
  )
  const rawSeed = values.get('--seed')
  const parsed = argsSchema.safeParse({
    reset: flags.has('--reset'),
    additive: flags.has('--additive'),
    dryRun: flags.has('--dry-run'),
    iAmSure: flags.has('--i-am-sure'),
    seed: rawSeed === undefined ? DEFAULT_SEED : Number(rawSeed),
    password: values.get('--password') ?? DEFAULT_PASSWORD,
  })
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`, {})
  }
  return parsed.data
}

function loadEnv(): z.infer<typeof envSchema> {
  // Convenience for local runs; a shell-exported environment works too.
  try {
    process.loadEnvFile('.env.local')
  } catch {
    // No .env.local — fall through to whatever is already in process.env.
  }
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new AppError('CONFIG_ERROR', 'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')),
    })
  }
  return parsed.data
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

async function insertRows<N extends TableName>(
  admin: SupabaseClient<Database>,
  table: N,
  rows: readonly Database['public']['Tables'][N]['Insert'][],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE)
    const { error } = await admin.from(table).insert(batch as never)
    if (error) {
      throw new AppError('DB_ERROR', `Insert into "${table}" failed: ${error.message}`, {
        table, offset, batchSize: batch.length, details: error.details,
      })
    }
  }
  log(`  ${table.padEnd(20)} ${rows.length}`)
}

async function countClients(admin: SupabaseClient<Database>): Promise<number> {
  const { count, error } = await admin.from('clients').select('*', { count: 'exact', head: true })
  if (error) {
    throw new AppError('DB_ERROR', `Could not read existing clients: ${error.message}`, {})
  }
  return count ?? 0
}

async function resetDatabase(admin: SupabaseClient<Database>): Promise<void> {
  log('Resetting existing data…')
  for (const table of TABLES_IN_DELETE_ORDER) {
    // supabase-js requires a filter on delete; every table here has a uuid pk,
    // so "id is not the nil uuid" matches every real row.
    const { error } = await admin.from(table).delete().neq('id', NIL_UUID)
    if (error) {
      throw new AppError('DB_ERROR', `Delete from "${table}" failed: ${error.message}`, { table })
    }
  }
  await deleteDemoAuthUsers(admin)
  log('  reset complete')
}

async function deleteDemoAuthUsers(admin: SupabaseClient<Database>): Promise<void> {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
  if (error) {
    throw new AppError('DB_ERROR', `Could not list auth users: ${error.message}`, {})
  }
  const demoEmails = new Set([OPERATOR_EMAIL, CLIENT_EMAIL])
  for (const user of data.users) {
    if (!user.email || !demoEmails.has(user.email)) continue
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id)
    if (deleteError) {
      throw new AppError('DB_ERROR', `Could not delete auth user ${user.email}: ${deleteError.message}`, {})
    }
  }
}

async function createAuthUser(
  admin: SupabaseClient<Database>,
  email: string,
  password: string,
): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) {
    throw new AppError('DB_ERROR', `Could not create auth user ${email}: ${error?.message ?? 'no user returned'}`, {
      email,
      hint: error?.message.includes('already') ? 'Re-run with --reset to replace the existing user.' : undefined,
    })
  }
  return data.user.id
}

async function insertDataset(admin: SupabaseClient<Database>, data: SeedDataset): Promise<void> {
  log('Inserting rows…')
  // FK-safe order. `emails` is self-referencing via in_reply_to_email_id, but the
  // generator always emits an inbound message before the reply that points at it,
  // and batches preserve that order.
  await insertRows(admin, 'clients', data.clients)
  await insertRows(admin, 'mailboxes', data.mailboxes)
  await insertRows(admin, 'campaigns', data.campaigns)
  await insertRows(admin, 'cases', data.cases)
  await insertRows(admin, 'leads', data.leads)
  await insertRows(admin, 'case_knowledge', data.caseKnowledge)
  await insertRows(admin, 'emails', data.emails)
  await insertRows(admin, 'sequences', data.sequences)
  await insertRows(admin, 'knowledge_requests', data.knowledgeRequests)
  await insertRows(admin, 'suppressions', data.suppressions)
  await insertRows(admin, 'events', data.events)
}

function printDryRunSummary(data: SeedDataset): void {
  const counts: readonly (readonly [string, number])[] = [
    ['clients', data.clients.length],
    ['campaigns', data.campaigns.length],
    ['mailboxes', data.mailboxes.length],
    ['cases', data.cases.length],
    ['leads', data.leads.length],
    ['case_knowledge', data.caseKnowledge.length],
    ['emails', data.emails.length],
    ['sequences', data.sequences.length],
    ['knowledge_requests', data.knowledgeRequests.length],
    ['suppressions', data.suppressions.length],
    ['events', data.events.length],
  ]
  log('Dry run — nothing written. Row counts:')
  for (const [name, count] of counts) log(`  ${name.padEnd(20)} ${count}`)

  const drafts = data.emails.filter((email) => email.status === 'draft').length
  const openRequests = data.knowledgeRequests.filter((request) => request.status === 'open').length
  const replies = data.emails.filter((email) => email.direction === 'inbound').length
  log(`  → ${drafts} drafts and ${openRequests} open knowledge requests will appear in /inbox`)
  log(`  → ${replies} inbound replies drive the reply rate on /analytics`)
}

function isLocalSupabaseUrl(url: string): boolean {
  const hostname = new URL(url).hostname
  return hostname === 'localhost' || hostname === '127.0.0.1'
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const env = loadEnv()
  const admin = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  if (args.dryRun) {
    printDryRunSummary(generateSeedData({ seed: args.seed, today: new Date(), operatorUserId: NIL_UUID }))
    return
  }

  // This script creates auth users with a well-known, checked-in default
  // password and (with --reset) unconditionally deletes rows. Anything other
  // than the local Supabase CLI instance needs an explicit, deliberate opt-in.
  if (!args.iAmSure && !isLocalSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `NEXT_PUBLIC_SUPABASE_URL (${env.NEXT_PUBLIC_SUPABASE_URL}) is not a local Supabase instance. ` +
        'Re-run with --i-am-sure if you really mean to seed/reset this target.',
      {},
    )
  }

  if (args.reset) {
    await resetDatabase(admin)
  } else if (!args.additive) {
    const existing = await countClients(admin)
    if (existing > 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Database already has ${existing} client(s). Re-run with --reset to replace them, or --additive to add a new fake client alongside existing data.`,
        {},
      )
    }
  }

  log(`Creating auth users…`)
  const operatorUserId = await createAuthUser(admin, OPERATOR_EMAIL, args.password)
  const clientUserId = await createAuthUser(admin, CLIENT_EMAIL, args.password)

  const data = generateSeedData({ seed: args.seed, today: new Date(), operatorUserId })
  await insertDataset(admin, data)

  // app_users must land after clients: the client-role row references one, and
  // app_users_client_role_ck requires operator rows to have a null client_id.
  const { error: appUsersError } = await admin.from('app_users').insert([
    { id: operatorUserId, role: 'operator', client_id: null },
    { id: clientUserId, role: 'client', client_id: data.demoClientId },
  ])
  if (appUsersError) {
    throw new AppError('DB_ERROR', `app_users insert failed: ${appUsersError.message}`, {})
  }

  const demoClientName = data.clients.find((client) => client.id === data.demoClientId)?.name ?? 'unknown'
  log('')
  log('Done. Sign in at http://localhost:3000/login')
  log(`  operator  ${OPERATOR_EMAIL}  /  ${args.password}   (sees all clients, gets /campaigns)`)
  log(`  client    ${CLIENT_EMAIL}  /  ${args.password}   (scoped to "${demoClientName}")`)
  log('')
  log('Note: mailbox OAuth tokens are placeholders, so "send test email" on /settings will fail.')
}

main().catch((error: unknown) => {
  const message = error instanceof AppError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
