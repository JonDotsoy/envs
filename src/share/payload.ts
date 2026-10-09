import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Values } from "../envs";

type Value = string | number | boolean;

export const PROFILE = "main";

export interface Payload {
  version: 1;
  profile: string;
  generatedAt: string;
  values: Record<string, Value>;
}

export const sharingFilePath = (root: string) => join(root, ".envs/sharing-envs");

/** Resolves a profile the same way `envs push` does: `defaults`, overridden by `envs[KEY][profile]`. */
export function buildPayload(values: Values, profile: string, now: Date): Payload {
  const resolved: Record<string, Value> = { ...(values.defaults ?? {}) };
  for (const [key, byProfile] of Object.entries(values.envs ?? {})) {
    if (profile in byProfile) resolved[key] = byProfile[profile]!;
  }
  return { version: 1, profile, generatedAt: now.toISOString(), values: resolved };
}

/** Parses and validates a decrypted payload; never trust the shape of remote data. */
export function parsePayload(text: string): Payload {
  const data = JSON.parse(text) as Partial<Payload>;
  if (data.version !== 1 || typeof data.profile !== "string" || !data.values || typeof data.values !== "object") {
    throw new Error("Unsupported payload");
  }
  const values: Record<string, Value> = {};
  for (const [key, value] of Object.entries(data.values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid variable name in payload: ${JSON.stringify(key)}`);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Invalid value type for ${key}`);
    }
    values[key] = value;
  }
  return { version: 1, profile: data.profile, generatedAt: String(data.generatedAt ?? ""), values };
}

/** Adds the payload to `defaults`; existing keys are kept unless `force`. Mutates `values`. */
export function mergePayload(values: Values, payload: Payload, force: boolean) {
  const defaults = (values.defaults ??= {});
  const added: string[] = [];
  const overwritten: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  for (const [key, value] of Object.entries(payload.values)) {
    if (!(key in defaults)) {
      defaults[key] = value;
      added.push(key);
    } else if (String(defaults[key]) === String(value)) {
      unchanged.push(key);
    } else if (force) {
      defaults[key] = value;
      overwritten.push(key);
    } else {
      conflicts.push(key);
    }
  }
  return { added, overwritten, unchanged, conflicts };
}

/** Writes the encrypted container with owner-only permissions. */
export async function writeSharingFile(root: string, sealed: Uint8Array) {
  const path = sharingFilePath(root);
  await writeFile(path, sealed, { mode: 0o600 });
  await chmod(path, 0o600);
}

export const removeSharingFile = (root: string) => rm(sharingFilePath(root), { force: true });
