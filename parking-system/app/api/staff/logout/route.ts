import { clearStaffSession } from '@/server/http/staffAuth'

export async function POST(): Promise<Response> {
  await clearStaffSession()
  return Response.json({ ok: true })
}
