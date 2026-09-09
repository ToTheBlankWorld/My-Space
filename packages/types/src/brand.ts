declare const brand: unique symbol;

/**
 * Nominal typing helper.
 *
 * A branded type is structurally a `T` at runtime but is not assignable from a
 * bare `T`, so a validated value can never be confused with an unvalidated one.
 * Brands are created exclusively by the parsers in `@space/validation`.
 *
 * @example
 * type UserId = Brand<string, 'UserId'>;
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
