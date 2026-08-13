import { describe, it, expect } from 'vitest'
import { GET } from './route'
import { MARKETING_LOCALE_COOKIE } from '@/lib/i18n/resolve-marketing-locale'

function request(search: string): Request {
  return new Request(`http://localhost:3000/api/locale${search}`)
}

function locationOf(response: Response): string {
  return response.headers.get('location') ?? ''
}

describe('GET /api/locale', () => {
  it('should set the cookie and redirect to /tr for a valid tr locale', async () => {
    const response = await GET(request('?locale=tr'))
    expect(locationOf(response)).toBe('http://localhost:3000/tr')
    expect(response.cookies.get(MARKETING_LOCALE_COOKIE)?.value).toBe('tr')
  })

  it('should set the cookie and redirect to / for a valid en locale', async () => {
    const response = await GET(request('?locale=en'))
    expect(locationOf(response)).toBe('http://localhost:3000/')
    expect(response.cookies.get(MARKETING_LOCALE_COOKIE)?.value).toBe('en')
  })

  it('should reject an unsupported locale without setting a cookie', async () => {
    const response = await GET(request('?locale=fr'))
    expect(response.status).toBe(400)
    expect(response.cookies.get(MARKETING_LOCALE_COOKIE)).toBeUndefined()
  })

  it('should reject a missing locale param', async () => {
    const response = await GET(request(''))
    expect(response.status).toBe(400)
  })
})
