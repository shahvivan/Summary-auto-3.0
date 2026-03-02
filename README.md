# LecturePrep Autopilot

Production-oriented Moodle lecture preparation pipeline:

- Scheduler (mock or ICS URL)
- Resolver (mock Moodle JSON or live Playwright Moodle browser)
- Material extraction (PDF + PPT)
- AI summary routing (Gemini primary, ChatPDF fallback, deterministic offline mode)
- Run/session persistence with resolver/provider/schema traces
- Web cockpit (`/`, `/session/:id`, `/history`, `/settings`)

## 1. Quick start (local)

```bash
cd "/Users/jignesh/Documents/New project 4"
npm install
npm run start
```

Open: [http://localhost:3100](http://localhost:3100)

## 2. CLI examples

```bash
# Today (from scheduler)
npm run run-daily -- --date=2026-03-02

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
- `RESOLVER_USE_LIVE_MOODLE=true`
- `MOODLE_BASE_URL=https://ecampus.esade.edu/my/`
- `PLAYWRIGHT_USER_DATA_DIR=<absolute path>`
- `GEMINI_API_KEY=<key>`
- `CHATPDF_API_KEY=<key>`
- `CHATPDF_SOURCE_ID=<source id>`
- `SUMMARY_PROVIDER_DEFAULT=auto|gemini|chatpdf|deterministic`

## 4. First-time Playwright auth profile (required for live Moodle)

This project uses a persistent browser profile. Create/login once, then reuse.

```bash
mkdir -p "/Users/jignesh/Documents/New project 4/data/storage/playwright-profile"

npx playwright open \
  --browser=chromium \
  --user-data-dir="/Users/jignesh/Documents/New project 4/data/storage/playwright-profile" \
  "https://ecampus.esade.edu/my/"
```

Then complete login + MFA in that opened browser and close it.

After this, live resolver runs reuse the stored authenticated session.

## 5. Course map

Course-to-URL mapping is stored in:

- `data/config/course-map.json`

Preloaded with:

- Accounting I BBA & DBAI & GBL
- Business Law II (sections C, D E & F)
- Macroeconomics in a Global Context Sec: F
- Descriptive Statistics & Probability

## 6. Resolver behavior

Override precedence is deterministic:

1. `sectionId`
2. `topicNumber`
3. `contains`
4. historical anchor
5. automatic inference

Automatic mode biases:

- topic/session number match
- semantic keyword overlap
- recency by section order/number
- PDF/PPT density

Material filtering:

- only `pdf`/`ppt`
- returns newest subset (`RESOLVER_RECENT_LIMIT`, default 2)

## 7. Debug traces

Per run trace file:

- `data/storage/debug/<runId>.json`

Includes:

- resolver selection + scoring
- navigation steps
- DOM stats
- optional HTML snapshot (`resolver.debug.htmlSnapshot`) when `moodleDebug=true`
- provider trace
- schema validation trace

## 8. APIs

Current endpoints (backward compatible + aliases):

- `GET /api/health`
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

Provider override accepted on run endpoints:

- `provider=auto|gemini|chatpdf|deterministic`

Resolver runtime flags accepted:

- `moodleDebug=true|false`
- `requireAuth=true|false`

## 9. Testing

```bash
npx tsc --noEmit
npm test -- --runInBand
```

## 10. What to provide for resolver calibration

For each problematic Moodle course/page, provide:

1. course URL
2. target section name you expected
3. resulting selected section from debug
4. raw resolver trace (`data/storage/debug/<runId>.json`)
5. HTML snapshot of the course page after expansion
6. screenshot of the resource list

This is enough to tune section ranking + file-type extraction for your exact Moodle theme.
