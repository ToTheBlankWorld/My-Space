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
 * A Content-Security-Policy ahead of the browser defaults: no remote scripts,
 * no inline script execution, no framing, nothing loaded across the origin
 * boundary except the two things the app already allows.
 *
 * This is production-only on purpose. Next's development server evaluates
 * scripts for hot-reload and would trip the `'self'`-only script policy and
 * every refresh in dev; shipping the strict policy only where it is intended
 * to be enforced keeps development usable without weakening production.
 */
const strictCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://lh3.googleusercontent.com https://*.googleusercontent.com",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

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
              { key: 'Content-Security-Policy', value: strictCsp },
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
