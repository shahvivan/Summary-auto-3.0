import path from "node:path";
import { config } from "../../config.js";

export interface ResolverAuthOptions {
  userDataDir?: string;
  requireAuth?: boolean;
}

export function resolveUserDataDir(overrideDir?: string): string {
  const dir = overrideDir || config.playwrightUserDataDir;
  return path.resolve(dir);
}

export function looksLikeLoginPage(params: {
  url: string;
  title?: string;
  hasPasswordInput?: boolean;
}): boolean {
  const haystack = `${params.url} ${params.title ?? ""}`.toLowerCase();
  if (params.hasPasswordInput) {
    return true;
  }
  return /\blogin\b|\bsign in\b|\bauth\b/.test(haystack);
}
