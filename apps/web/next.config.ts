import type { NextConfig } from 'next';

/**
 * Headers applied to every response.
 *
 * These are cheap, static protections that should exist before any
 * authenticated surface does — retrofitting them after a session cookie exists
 * is how gaps get shipped.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/**
 * The Content-Security-Policy intentionally does not live here.
 *
 * It carries a per-request nonce for `script-src` (so Next.js can run its
 * inline bootstrap/RSC scripts under a policy with no `'unsafe-inline'`) and
 * it lets the Google OAuth form-result redirect reach `accounts.google.com`.
 * Both values are only known per request, and `headers()` is static, so the
 * proxy builds and applies the policy at edge time. This is still
 * production-only on purpose: Next's development server evaluates scripts for
 * hot-reload and would trip a strict script policy on every refresh.
 */
const isProduction = process.env.NODE_ENV === 'production';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Workspace packages ship TypeScript sources and are compiled by the app.
  transpilePackages: [
    '@space/auth',
    '@space/ui',
    '@space/config',
    '@space/database',
    '@space/engine',
    '@space/logger',
    '@space/planning',
    '@space/time',
    '@space/types',
    '@space/validation',
  ],

  // Prisma and its driver are Node-only and must not be traced into a bundle.
  // `serverExternalPackages` keeps them as runtime requires on the server.
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg', 'pg'],

  headers: () =>
    Promise.resolve([
      {
        source: '/:path*',
        headers: isProduction
          ? [
              ...securityHeaders,
              {
                key: 'Strict-Transport-Security',
                value: 'max-age=31536000; includeSubDomains',
              },
            ]
          : securityHeaders,
      },
    ]),
};

export default nextConfig;
