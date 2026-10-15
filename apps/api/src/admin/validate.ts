/**
 * Input validation for the admin write path.
 *
 * Deliberately small and explicit rather than schema-driven. The admin API has
 * around a dozen endpoints and a handful of field types, so a declarative schema
 * library would add a dependency and a layer of indirection to save a few lines.
 *
 * Every function here throws `ValidationError` with a message that names the
 * field. The route layer turns that into a 400 with the same message, so a
 * misconfigured client gets a usable answer instead of a 500.
 */

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function requireString(
  source: Record<string, unknown>,
  field: string,
  options: { max?: number; min?: number } = {},
): string {
  const raw = source[field];
  if (typeof raw !== "string") {
    throw new ValidationError(`${field} must be a string`, field);
  }
  const value = raw.trim();
  const min = options.min ?? 1;
  if (value.length < min) {
    throw new ValidationError(`${field} must not be empty`, field);
  }
  if (options.max !== undefined && value.length > options.max) {
    throw new ValidationError(`${field} must be at most ${options.max} characters`, field);
  }
  return value;
}

export function optionalString(
  source: Record<string, unknown>,
  field: string,
  options: { max?: number } = {},
): string | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new ValidationError(`${field} must be a string`, field);
  }
  const value = raw.trim();
  if (value === "") return undefined;
  if (options.max !== undefined && value.length > options.max) {
    throw new ValidationError(`${field} must be at most ${options.max} characters`, field);
  }
  return value;
}

export function nullableString(
  source: Record<string, unknown>,
  field: string,
  options: { max?: number } = {},
): string | null | undefined {
  const raw = source[field];
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "string") {
    throw new ValidationError(`${field} must be a string or null`, field);
  }
  const value = raw.trim();
  if (value === "") return null;
  if (options.max !== undefined && value.length > options.max) {
    throw new ValidationError(`${field} must be at most ${options.max} characters`, field);
  }
  return value;
}

export function requireInt(
  source: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number } = {},
): number {
  const raw = source[field];
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new ValidationError(`${field} must be an integer`, field);
  }
  if (options.min !== undefined && raw < options.min) {
    throw new ValidationError(`${field} must be at least ${options.min}`, field);
  }
  if (options.max !== undefined && raw > options.max) {
    throw new ValidationError(`${field} must be at most ${options.max}`, field);
  }
  return raw;
}

export function optionalInt(
  source: Record<string, unknown>,
  field: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  if (source[field] === undefined || source[field] === null) return undefined;
  return requireInt(source, field, options);
}

export function optionalBool(
  source: Record<string, unknown>,
  field: string,
): boolean | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    throw new ValidationError(`${field} must be a boolean`, field);
  }
  return raw;
}

export function requireEnum<T extends string>(
  source: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const raw = source[field];
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(", ")}`, field);
  }
  return raw as T;
}

export function optionalEnum<T extends string>(
  source: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (source[field] === undefined || source[field] === null) return undefined;
  return requireEnum(source, field, allowed);
}

export function optionalStringArray(
  source: Record<string, unknown>,
  field: string,
  options: { max?: number } = {},
): string[] | undefined {
  const raw = source[field];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ValidationError(`${field} must be an array of strings`, field);
  }
  if (options.max !== undefined && raw.length > options.max) {
    throw new ValidationError(`${field} must contain at most ${options.max} entries`, field);
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ValidationError(`${field} must contain non-empty strings`, field);
    }
    out.push(entry.trim());
  }
  return out;
}

export function requireSlug(source: Record<string, unknown>, field = "slug"): string {
  const value = requireString(source, field, { max: 64 });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new ValidationError(
      `${field} must be lowercase alphanumeric words separated by single hyphens`,
      field,
    );
  }
  return value;
}
