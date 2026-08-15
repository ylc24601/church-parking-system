import { NOTIFICATION_LEASE_SECONDS } from '@/lib/allocation/rules'
import {
  createParkingRepository,
  type OutboxHealth,
  type ParkingRepository,
} from '@/server/repositories/parkingRepository'

// Phase 4 Slice C — operation-safe outbox health for ops visibility (CLI + internal route).
// Thin wrapper over the outbox_health RPC: counts / notification-type names / sanitized error
// codes / timestamps only. Uses the same lease window as the dispatcher so `stale_processing`
// matches what a real run would reclaim.
export async function getOutboxHealth(
  params: { now?: Date } = {},
  repo: ParkingRepository = createParkingRepository(),
): Promise<OutboxHealth> {
  const now = params.now ?? new Date()
  return repo.getOutboxHealth(now.toISOString(), NOTIFICATION_LEASE_SECONDS)
}
