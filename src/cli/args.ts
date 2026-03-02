export function parseCliArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, ...rest] = arg.slice(2).split("=");
    if (!rawKey) {
      continue;
    }

    if (rest.length === 0) {
      out[rawKey] = true;
    } else {
      out[rawKey] = rest.join("=");
    }
  }

  return out;
}
