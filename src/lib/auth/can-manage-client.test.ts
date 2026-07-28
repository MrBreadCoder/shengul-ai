import { describe, it, expect } from 'vitest'
import type { AppUser } from '@/lib/db/app-users'
import { canManageClient, canManageOwnRow } from './can-manage-client'

const operator: AppUser = { id: 'op1', role: 'operator', client_id: null, created_at: '2026-01-01T00:00:00Z' }
const client: AppUser = { id: 'u1', role: 'client', client_id: 'c1', created_at: '2026-01-01T00:00:00Z' }
const otherClient: AppUser = { id: 'u2', role: 'client', client_id: 'c2', created_at: '2026-01-01T00:00:00Z' }

describe('canManageClient', () => {
  it('should allow an operator for any client', () => {
    expect(canManageClient(operator, 'c1')).toBe(true)
    expect(canManageClient(operator, 'c2')).toBe(true)
  })

  it('should allow a client user for its own client', () => {
    expect(canManageClient(client, 'c1')).toBe(true)
  })

  it('should reject a client user for another client', () => {
    expect(canManageClient(otherClient, 'c1')).toBe(false)
  })

  it('should reject a client user whose client_id is null', () => {
    expect(canManageClient({ ...client, client_id: null }, 'c1')).toBe(false)
  })
})

describe('canManageOwnRow', () => {
  const row = { client_id: 'c1', created_by: 'u1' }

  it('should allow an operator regardless of who created the row', () => {
    expect(canManageOwnRow(operator, row)).toBe(true)
  })

  it('should allow the client user who created the row', () => {
    expect(canManageOwnRow(client, row)).toBe(true)
  })

  it('should reject a client user who did not create the row', () => {
    expect(canManageOwnRow({ ...client, id: 'u9' }, row)).toBe(false)
  })

  it('should reject a client user from another client even if ids collide', () => {
    expect(canManageOwnRow({ ...otherClient, id: 'u1' }, row)).toBe(false)
  })
})
