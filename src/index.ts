import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiRouter } from "./api/routes.js";
import { config } from "./config.js";
import { clearAllRuns, initStorage } from "./storage/sqlite.js";
import { logInfo } from "./utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  await initStorage();
  // Clear all previous run history on every start — gives a clean slate each
  // time the app is opened so stale errors and completed runs don't accumulate.
  clearAllRuns();
  logInfo(
    `Providers configured: gemini=${config.geminiEnabled}, chatpdf=${config.chatpdfEnabled}, deterministic=${config.deterministicEnabled}`,
  );

  const app = express();
  app.use(express.json());

  app.use("/api", createApiRouter());

  const webDir = path.join(__dirname, "web");
  app.use(express.static(webDir));

  app.get("/session/:sessionId", (_req, res) => {
    res.sendFile(path.join(webDir, "session.html"));
  });

  app.get("/history", (_req, res) => {
    res.sendFile(path.join(webDir, "history.html"));
  });

  app.get("/settings", (_req, res) => {
    res.sendFile(path.join(webDir, "settings.html"));
  });

  app.get("*", (_req, res) => {
    res.sendFile(path.join(webDir, "index.html"));
  });

  const server = app.listen(config.port, () => {
    logInfo(`Esade Autopilot running at http://localhost:${config.port}`);
  });

  // Graceful shutdown — without this, tsx watch can't kill the process
  // and gets stuck in the "Force killing" loop forever.
  const shutdown = (signal: string) => {
    logInfo(`Received ${signal}, shutting down...`);
    server.close(() => process.exit(0));
    // Force exit after 1 second if server.close() stalls (e.g. open connections)
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
