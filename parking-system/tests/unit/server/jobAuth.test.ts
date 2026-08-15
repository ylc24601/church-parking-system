import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cronOrJobSecretValid, jobSecretValid } from '@/server/http/jobAuth'

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})
beforeEach(() => {
  delete process.env.JOB_TRIGGER_SECRET
  delete process.env.CRON_SECRET
})

const req = (headers: Record<string, string>) =>
  new Request('http://localhost/api/internal/jobs/dispatch-notifications', { headers })

describe('jobSecretValid', () => {
  it('matches x-job-secret against JOB_TRIGGER_SECRET', () => {
    process.env.JOB_TRIGGER_SECRET = 'sekret'
    expect(jobSecretValid('sekret')).toBe(true)
    expect(jobSecretValid('nope')).toBe(false)
  })
  it('fails closed when the expected secret is unset or empty', () => {
    expect(jobSecretValid('anything')).toBe(false) // unset
    process.env.JOB_TRIGGER_SECRET = ''
    expect(jobSecretValid('')).toBe(false)
    expect(jobSecretValid('anything')).toBe(false)
  })
})

describe('cronOrJobSecretValid', () => {
  it('accepts a valid x-job-secret', () => {
    process.env.JOB_TRIGGER_SECRET = 'jobsek'
    expect(cronOrJobSecretValid(req({ 'x-job-secret': 'jobsek' }))).toBe(true)
  })

  it('accepts a valid Vercel-Cron Authorization: Bearer $CRON_SECRET', () => {
    process.env.CRON_SECRET = 'cronsek'
    expect(cronOrJobSecretValid(req({ authorization: 'Bearer cronsek' }))).toBe(true)
  })

  it('rejects when neither header matches', () => {
    process.env.JOB_TRIGGER_SECRET = 'jobsek'
    process.env.CRON_SECRET = 'cronsek'
    expect(cronOrJobSecretValid(req({ 'x-job-secret': 'wrong', authorization: 'Bearer wrong' }))).toBe(false)
    expect(cronOrJobSecretValid(req({}))).toBe(false)
  })

  it('fails closed when the expected secrets are unset', () => {
    // no env set → any header must be rejected
    expect(cronOrJobSecretValid(req({ 'x-job-secret': 'x' }))).toBe(false)
    expect(cronOrJobSecretValid(req({ authorization: 'Bearer y' }))).toBe(false)
  })

  it('fails closed when the expected secret is an empty string', () => {
    process.env.CRON_SECRET = ''
    expect(cronOrJobSecretValid(req({ authorization: 'Bearer ' }))).toBe(false)
  })

  it('rejects an Authorization header without the Bearer scheme', () => {
    process.env.CRON_SECRET = 'cronsek'
    expect(cronOrJobSecretValid(req({ authorization: 'cronsek' }))).toBe(false)
    expect(cronOrJobSecretValid(req({ authorization: 'Basic cronsek' }))).toBe(false)
    expect(cronOrJobSecretValid(req({ authorization: 'bearer cronsek' }))).toBe(false) // case-sensitive scheme
  })

  it('rejects a wrong-length token (constant-time guard) ', () => {
    process.env.CRON_SECRET = 'cronsek'
    expect(cronOrJobSecretValid(req({ authorization: 'Bearer cronsekEXTRA' }))).toBe(false)
  })

  it('accepts when both headers are present and exactly one is valid', () => {
    process.env.JOB_TRIGGER_SECRET = 'jobsek'
    process.env.CRON_SECRET = 'cronsek'
    // valid job secret, bogus bearer
    expect(cronOrJobSecretValid(req({ 'x-job-secret': 'jobsek', authorization: 'Bearer wrong' }))).toBe(true)
    // bogus job secret, valid bearer
    expect(cronOrJobSecretValid(req({ 'x-job-secret': 'wrong', authorization: 'Bearer cronsek' }))).toBe(true)
  })
})
