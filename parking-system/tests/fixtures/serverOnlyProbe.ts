// Probe for tests/unit/scripts/cliServerBoundary.test.ts — do not import this from
// anywhere else. It is spawned as a standalone tsx entry point, twice: once with the
// flags the CLI scripts actually use (must succeed) and once without them (must fail).
//
// It imports the module every service/repository path reaches, and nothing else. The
// import ALONE is the test: `server-only` throws at module-evaluation time, so reaching
// the next line already proves the react-server condition was resolved.
//
// getServiceClient() is deliberately NOT called — it is lazy, so this probe needs no
// database, no env vars, and has no side effects.
import { getServiceClient } from '../../lib/supabase/server'

if (typeof getServiceClient !== 'function') {
  throw new Error('serverOnlyProbe: getServiceClient did not load as a function')
}

console.log('SERVER_ONLY_PROBE_OK')
