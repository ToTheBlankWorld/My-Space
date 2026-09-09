import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

import { baseConfig } from './base.js';

/**
 * ESLint configuration for React workspaces.
 *
 * `eslint-plugin-react` is deliberately absent: its 7.x line is not compatible
 * with ESLint 10, and with React 19 plus strict TypeScript its remaining value
 * (prop-types, JSX runtime hygiene) is already covered by the compiler. The
 * rules that catch real defects live in `eslint-plugin-react-hooks`.
 *
 * @type {import('eslint').Linter.Config[]}
 */
export const reactConfig = [
  ...baseConfig,
  reactHooks.configs.flat['recommended-latest'],
  {
    files: ['**/*.{jsx,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
];

export default reactConfig;
