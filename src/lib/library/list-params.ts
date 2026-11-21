/*
 * The library page's query parameters. Anyone can type them into the address
 * bar, and PostgreSQL refuses what is not a whole number or a UUID, so
 * anything else counts as not given. Pure functions.
 */

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim() || undefined;

/** A parameter's value, or its first one when it is given more than once. */
export const oneParam = first;

/** The page number: a whole number from 1 on; page 1 for anything else. */
export function pageParam(value: string | string[] | undefined): number {
  const text = first(value) ?? "";
  return /^[1-9]\d{0,5}$/.test(text) ? Number(text) : 1;
}

/** A UUID, or undefined for anything else. */
export function idParam(value: string | string[] | undefined): string | undefined {
  const text = first(value);
  return text && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(text) ? text : undefined;
}
