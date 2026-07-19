import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

// Integration test: runs against local `supabase start`. Reads local keys from env.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const admin = createClient<Database>(url, service, { auth: { persistSession: false } })

const clientAEmail = `a-${Date.now()}@test.local`
const clientBEmail = `b-${Date.now()}@test.local`
const password = 'test-password-123'

let clientAId = ''
let clientBId = ''

async function makeUser(email: string, clientId: string | null, role: 'operator' | 'client') {
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`)
  const { error: insErr } = await admin.from('app_users')
    .insert({ id: data.user.id, role, client_id: clientId })
  if (insErr) throw new Error(`app_users insert failed: ${insErr.message}`)
  return data.user.id
}

beforeAll(async () => {
  const { data: ca } = await admin.from('clients').insert({ name: 'Client A' }).select('id').single()
  const { data: cb } = await admin.from('clients').insert({ name: 'Client B' }).select('id').single()
  clientAId = ca!.id
  clientBId = cb!.id
  await makeUser(clientAEmail, clientAId, 'client')
  await makeUser(clientBEmail, clientBId, 'client')
  await admin.from('campaigns').insert([
    { client_id: clientAId, name: 'A campaign' },
    { client_id: clientBId, name: 'B campaign' },
  ])
}, 30_000)

describe('RLS per-client isolation', () => {
  it('should return only its own campaigns when a client user reads', async () => {
    const asA = createClient<Database>(url, anon, { auth: { persistSession: false } })
    await asA.auth.signInWithPassword({ email: clientAEmail, password })
    const { data, error } = await asA.from('campaigns').select('client_id')
    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(data!.every((row) => row.client_id === clientAId)).toBe(true)
    expect(data!.some((row) => row.client_id === clientBId)).toBe(false)
  })

  it('should return zero rows when a client user reads another client via explicit filter', async () => {
    const asA = createClient<Database>(url, anon, { auth: { persistSession: false } })
    await asA.auth.signInWithPassword({ email: clientAEmail, password })
    const { data } = await asA.from('campaigns').select('id').eq('client_id', clientBId)
    expect(data).toEqual([])
  })

  it('should reject a client-user insert (write policy is operator-only)', async () => {
    const asA = createClient<Database>(url, anon, { auth: { persistSession: false } })
    await asA.auth.signInWithPassword({ email: clientAEmail, password })
    const { error } = await asA.from('campaigns').insert({ client_id: clientAId, name: 'hack' })
    expect(error).not.toBeNull()
  })
})
