import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // The gated `*.db.test.ts` integration tests share one local Supabase DB and
    // reuse fixed Sundays + seeded members (one-active-reservation-per-member is a
    // global unique index), so they must not run concurrently. Pure unit tests are
    // fast enough that serializing files at this scale costs nothing.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['lib/allocation/**'],
      thresholds: { lines: 95, functions: 95, branches: 90 },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      // `server-only` is a marker package: its default entry THROWS, and only the
      // "react-server" export condition resolves to a no-op (empty.js). Next.js sets
      // that condition when it builds Server Components; Vitest runs plain Node, so
      // without this every test that reaches a server module would die on the marker
      // rather than on anything real.
      //
      // Aliased to empty.js directly instead of adding 'react-server' to
      // resolve.conditions: the condition is global and would also flip react/next
      // onto their react-server builds, which is a much larger blast radius than the
      // one package we actually need neutralized here.
      'server-only': path.resolve(__dirname, 'node_modules/server-only/empty.js'),
    },
  },
})
