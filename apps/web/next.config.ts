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
        headers: securityHeaders,
      },
    ]),
};

export default nextConfig;
