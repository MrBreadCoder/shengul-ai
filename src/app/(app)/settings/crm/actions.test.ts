import { describe, it, expect, vi, beforeEach } from 'vitest'
import { selectCrmPipeline, disconnectCrm } from './actions'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getCrmConnectionForClient: vi.fn(),
  updateCrmConnectionPipeline: vi.fn(),
  deleteCrmConnection: vi.fn(),
}))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/db/crm-connections', () => ({
  getCrmConnectionForClient: hoisted.getCrmConnectionForClient,
  updateCrmConnectionPipeline: hoisted.updateCrmConnectionPipeline,
  deleteCrmConnection: hoisted.deleteCrmConnection,
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

function form(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.append(key, value)
  return data
}

const validForm = {
  pipelineId: 'p1',
  pipelineLabel: 'Sales',
  initialStageId: 's1',
  wonStageId: 's9',
  lostStageId: 's10',
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  hoisted.getCrmConnectionForClient.mockResolvedValue({ id: 'conn-1', client_id: 'c1' })
})

describe('selectCrmPipeline', () => {
  it('should persist the selection for the caller own connection', async () => {
    await selectCrmPipeline(form(validForm))

    expect(hoisted.updateCrmConnectionPipeline).toHaveBeenCalledWith({}, 'conn-1', {
      pipelineId: 'p1',
      pipelineLabel: 'Sales',
      initialStageId: 's1',
      wonStageId: 's9',
      lostStageId: 's10',
    })
  })

  it('should store nulls when the provider reported no closed stages', async () => {
    await selectCrmPipeline(form({ pipelineId: 'p1', pipelineLabel: 'Sales', initialStageId: 's1' }))

    expect(hoisted.updateCrmConnectionPipeline).toHaveBeenCalledWith(
      {}, 'conn-1', expect.objectContaining({ wonStageId: null, lostStageId: null }),
    )
  })

  it('should reject an operator, who does not own the CRM grant', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    await expect(selectCrmPipeline(form(validForm))).rejects.toThrow()
    expect(hoisted.updateCrmConnectionPipeline).not.toHaveBeenCalled()
  })

  it('should reject when the caller has no connection to configure', async () => {
    hoisted.getCrmConnectionForClient.mockResolvedValue(null)

    await expect(selectCrmPipeline(form(validForm))).rejects.toThrow()
  })

  it('should reject a submission missing the required pipeline fields', async () => {
    await expect(selectCrmPipeline(form({ pipelineId: 'p1' }))).rejects.toThrow()
    expect(hoisted.updateCrmConnectionPipeline).not.toHaveBeenCalled()
  })
})

describe('disconnectCrm', () => {
  it('should delete the caller own connection', async () => {
    await disconnectCrm()

    expect(hoisted.deleteCrmConnection).toHaveBeenCalledWith({}, 'conn-1')
  })

  it('should reject an operator, who does not own the CRM grant', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    await expect(disconnectCrm()).rejects.toThrow()
    expect(hoisted.deleteCrmConnection).not.toHaveBeenCalled()
  })

  it('should no-op safely when there is nothing connected', async () => {
    hoisted.getCrmConnectionForClient.mockResolvedValue(null)

    await expect(disconnectCrm()).resolves.toBeUndefined()
    expect(hoisted.deleteCrmConnection).not.toHaveBeenCalled()
  })
})
