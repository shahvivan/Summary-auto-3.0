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
  // A visible password input is the most reliable indicator.
  if (params.hasPasswordInput) {
    return true;
  }

  // Check the URL against known SSO / login hostnames and path patterns.
  // We deliberately avoid matching "\bauth\b" because ESADE's SAML redirect
  // URLs (e.g. ecampus.esade.edu/auth/saml2/...) contain that word even when
  // the user IS authenticated and the browser is simply bouncing through SSO.
  const urlLower = params.url.toLowerCase();
  const loginUrlPatterns = [
    /login\.microsoftonline\.com/,   // Microsoft SSO
    /login\.live\.com/,
    /accounts\.google\.com/,          // Google SSO
    /\/login\.php/,                   // Moodle login page
    /[?&]loginredirect/,              // Generic login redirect param
    /\/signin\b/,                     // Generic sign-in path
  ];
  if (loginUrlPatterns.some((pattern) => pattern.test(urlLower))) {
    return true;
  }

  // Check the page title for clear login-page signals.
  const titleLower = (params.title ?? "").toLowerCase();
  return /\bsign in\b|\blog in\b|\bplease log in\b/.test(titleLower);
}
