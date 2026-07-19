import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'

// Usage: tsx scripts/seed-operator.ts <email> <password>
async function main() {
  const [email, password] = process.argv.slice(2)
  if (!email || !password) throw new Error('Usage: seed-operator <email> <password>')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !service) throw new Error('Missing Supabase env')
  const admin = createClient<Database>(url, service, { auth: { persistSession: false } })

  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`)
  const { error: insErr } = await admin
    .from('app_users')
    .insert({ id: data.user.id, role: 'operator', client_id: null })
  if (insErr) throw new Error(`app_users insert failed: ${insErr.message}`)
  process.stdout.write(`Operator created: ${email} (${data.user.id})\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
