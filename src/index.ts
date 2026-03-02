import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiRouter } from "./api/routes.js";
import { config } from "./config.js";
import { initStorage } from "./storage/sqlite.js";
import { logInfo } from "./utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main(): Promise<void> {
  await initStorage();

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

  app.listen(config.port, () => {
    logInfo(`Esade Autopilot running at http://localhost:${config.port}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
