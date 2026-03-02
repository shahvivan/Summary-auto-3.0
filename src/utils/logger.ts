export function logInfo(message: string, meta?: unknown): void {
  if (meta === undefined) {
    console.log(`[INFO] ${message}`);
  } else {
    console.log(`[INFO] ${message}`, meta);
  }
}

export function logWarn(message: string, meta?: unknown): void {
  if (meta === undefined) {
    console.warn(`[WARN] ${message}`);
  } else {
    console.warn(`[WARN] ${message}`, meta);
  }
}

export function logError(message: string, meta?: unknown): void {
  if (meta === undefined) {
    console.error(`[ERROR] ${message}`);
  } else {
    console.error(`[ERROR] ${message}`, meta);
  }
}
