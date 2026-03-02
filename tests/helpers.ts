import fs from "node:fs/promises";
import { config } from "../src/config.js";
import { closeStorage, initStorage } from "../src/storage/sqlite.js";

export async function resetStorage(): Promise<void> {
  closeStorage();
  await fs.rm(config.storageDir, { recursive: true, force: true });
  await initStorage();
}
