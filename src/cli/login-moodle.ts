/**
 * login-moodle.ts
 *
 * Opens a headed Chromium browser at your Moodle dashboard so you can log in
 * manually. Once you are logged in and can see your courses, press ENTER in
 * this terminal. The authenticated session is saved to the persistent profile
 * directory and reused by every future autopilot run.
 *
 * Usage:
 *   npm run login:moodle
 */
import "dotenv/config";
import readline from "node:readline";
import { config } from "../config.js";
import { resolveUserDataDir } from "../core/resolver/auth-profile.js";
import { logInfo } from "../utils/logger.js";

async function main(): Promise<void> {
  let playwright: typeof import("playwright");
  try {
    playwright = await import("playwright");
  } catch {
    console.error("ERROR: playwright package not found. Run: npm install playwright && npx playwright install chromium");
    process.exit(1);
  }

  const userDataDir = resolveUserDataDir();
  const moodleUrl = config.moodleBaseUrl || "https://ecampus.esade.edu/my/";

  logInfo(`Playwright profile directory: ${userDataDir}`);
  logInfo(`Opening Moodle at: ${moodleUrl}`);
  logInfo("──────────────────────────────────────────────────────");
  logInfo("Log in with your ESADE credentials in the browser.");
  logInfo("Once you can see your courses/dashboard, come back here");
  logInfo("and press ENTER to save the session and close the browser.");
  logInfo("──────────────────────────────────────────────────────");

  const context = await playwright.chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(moodleUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Wait for ENTER in the terminal.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise<void>((resolve) => {
    rl.question("\n▶  Press ENTER when you are fully logged in…\n", () => {
      rl.close();
      resolve();
    });
  });

  // Verify login state before closing.
  const authProbe = await page.evaluate(() => ({
    title: document.title,
    hasPasswordInput: Boolean(document.querySelector("input[type='password']")),
    url: location.href,
  }));

  if (authProbe.hasPasswordInput) {
    logInfo("⚠  WARNING: a password input is still visible — you may not be fully logged in.");
    logInfo("   Close this window and run `npm run login:moodle` again.");
  } else {
    logInfo(`✓  Session saved! Logged in as: ${authProbe.title} (${authProbe.url})`);
    logInfo("   You can now run `npm run dev` and the autopilot will use this session.");
  }

  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
