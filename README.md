# LecturePrep Autopilot

Production-oriented Moodle lecture preparation pipeline:

- Scheduler (strict ICS or strict mock)
- Resolver (mock Moodle JSON or live Playwright Moodle browser)
- Material extraction (PDF + PPT)
- AI summary routing (Gemini primary, optional ChatPDF backup, deterministic offline mode)
- Run/session persistence with resolver/provider/schema traces
- Web cockpit (`/`, `/session/:id`, `/history`, `/settings`)

## 1. Quick start (local)

```bash
cd "/Users/jignesh/Documents/Summary auto 3.0"
npm install
npm run start
```

Open: [http://localhost:3100](http://localhost:3100)

## 2. CLI examples

```bash
# Today (from scheduler)
npm run run-daily -- --date=2026-03-02 --debug

# Manual single run
npm run run-daily -- --course="Descriptive Statistics & Probability" --topic=3 --date=2026-03-02

# Backtest
npm run backtest -- --from=2026-03-01 --to=2026-03-05

# Provider + live resolver controls
npm run run-daily -- --course="Descriptive Statistics & Probability" --topic=3 --provider=auto --moodle-debug --require-auth
```

## 3. Environment setup

Copy `.env.example` into your runtime environment.

Key vars:

- `CALENDAR_USE_ICS=true`
- `CALENDAR_ICS_URL=<your outlook .ics url>`
- `ALLOW_MOCK_FALLBACK=false` (default)
- `RESOLVER_USE_LIVE_MOODLE=true`
- `MOODLE_BASE_URL=https://ecampus.esade.edu/my/`
- `PLAYWRIGHT_USER_DATA_DIR=<absolute path>`
- `GEMINI_API_KEY=<key>`
- `GEMINI_MODEL=gemini-2.0-flash`
- `CHATPDF_API_KEY=<optional>`
- `CHATPDF_SOURCE_ID=<optional>`
- `SUMMARY_PROVIDER_DEFAULT=auto|gemini|chatpdf|deterministic`

ChatPDF is enabled only when both `CHATPDF_API_KEY` and `CHATPDF_SOURCE_ID` are set.

## 4. Calendar source behavior

- If `CALENDAR_USE_ICS=true`: scheduler uses ICS source only.
- If ICS fails and `ALLOW_MOCK_FALLBACK=false`: run fails (no silent fallback).
- If ICS fails and `ALLOW_MOCK_FALLBACK=true`: scheduler logs warning and falls back to mock.

Expected logs:

- `[INFO] Calendar source: ICS`
- `[INFO] Calendar events loaded: N`
- `[WARN] ICS failed, falling back to mock because ALLOW_MOCK_FALLBACK=true` (only when allowed)

## 5. Provider behavior

- Auto mode order: Gemini -> ChatPDF (only if configured) -> deterministic
- `SUMMARY_PROVIDER_DEFAULT=chatpdf` with missing source id:
  - fallback enabled: warning + fallback to Gemini or deterministic
  - fallback disabled: fails with `Provider misconfigured`

Expected provider log:

- `[INFO] Providers configured: gemini=true|false, chatpdf=true|false, deterministic=true`

## 6. Debug traces

Per run trace file:

- `data/storage/debug/<runId>.json`

Includes:

- resolver selection + scoring
- navigation steps
- DOM stats
- optional HTML snapshot (`resolver.debug.htmlSnapshot`) when `moodleDebug=true`
- provider trace
- schema validation trace

## 7. APIs

Current endpoints:

- `GET /api/health`
- `GET /api/config-status`
- `GET /api/today`
- `POST /api/autopilot/today`
- `POST /api/run-today` (alias)
- `POST /api/session/prepare`
- `POST /api/run-session` (alias)
- `POST /api/session/:sessionId/override`
- `GET /api/run/:runId/status`
- `GET /api/session/:sessionId`
- `GET /api/session/:sessionId/debug`
- `GET /api/runs/latest`

## 8. Testing

```bash
npx tsc --noEmit
npm test -- --runInBand
```
