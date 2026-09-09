import 'server-only';

import { loadWebServerEnv } from '@space/config/web';

/**
 * Validated server-side environment for the web application.
 *
 * The `server-only` import is the enforcement mechanism: if this module is ever
 * pulled into a client bundle, the build fails instead of silently shipping
 * server configuration to the browser.
 *
 * Configuration is resolved once, at module load, so a misconfigured deployment
 * fails during build or boot rather than on a user's first request.
 */
export const serverEnv = loadWebServerEnv();
