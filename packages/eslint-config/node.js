import globals from 'globals';

import { baseConfig } from './base.js';

/**
 * ESLint configuration for Node.js workspaces (the worker, shared server packages).
 *
 * @type {import('eslint').Linter.Config[]}
 */
export const nodeConfig = [
  ...baseConfig,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-dom', 'next', 'next/*', '@space/ui', '@space/ui/*'],
              message: 'Node workspaces must not depend on browser or React-only code.',
            },
          ],
        },
      ],
    },
  },
];

export default nodeConfig;
