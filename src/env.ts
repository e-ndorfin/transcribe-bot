import "dotenv/config";

export function env(name: string, fallback?: string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing required environment variable: ${name}`);
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function numberEnv(name: string, fallback: number): number {
  const value = optionalEnv(name);
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number.`);
  }

  return parsed;
}

export function nonNegativeNumberEnv(name: string, fallback: number): number {
  const value = optionalEnv(name);
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${name} must be a non-negative number.`);
  }

  return parsed;
}

export function booleanEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name);
  if (!value) {
    return fallback;
  }

  const normalized = value.toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Environment variable ${name} must be a boolean.`);
}
