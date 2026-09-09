import { nextConfig } from '@space/eslint-config/next';

export default [
  ...nextConfig,
  {
    files: ['src/**/*.tsx'],
    rules: {
      // Client bundles must never reach for server configuration.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@space/config/worker',
                '@space/database',
                '@space/database/*',
                '**/env.server',
                '**/server/database',
              ],
              message:
                'Server-only modules must not be imported from a component. Read data in a Server Component or Route Handler and pass it down as props.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/app/**/{layout,page,route,not-found,error,sitemap,robots}.tsx', 'src/app/**/*.ts'],
    rules: {
      // Server Components are the intended place to read server configuration.
      'no-restricted-imports': 'off',
    },
  },
];
