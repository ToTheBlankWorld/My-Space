import { z } from 'zod';

/**
 * The runtime mode of a process.
 *
 * `NODE_ENV` is the only variable Space treats as always present: tooling sets
 * it implicitly, so it is defaulted rather than required.
 */
export const nodeEnvSchema = z.enum(['development', 'test', 'production']).default('development');

export type NodeEnv = z.infer<typeof nodeEnvSchema>;

export const isProduction = (env: NodeEnv): boolean => env === 'production';
export const isDevelopment = (env: NodeEnv): boolean => env === 'development';
export const isTest = (env: NodeEnv): boolean => env === 'test';
