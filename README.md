# LecturePrep Autopilot

> **Automated lecture preparation, powered by AI.** Reads your university calendar, finds today's lecture slides on Moodle, and delivers a structured study brief — before class starts.

---

## Why This Exists

University students spend a disproportionate amount of time on logistics that shouldn't require effort: logging into the learning platform, hunting down today's lecture materials across multiple course pages, downloading the right file, and skimming 80-slide decks for the three things that actually matter.

This project eliminates that friction entirely. It was built around one frustration: arriving at a lecture having read the wrong slides, or no slides at all, simply because finding and processing them took more time than was available between classes.

**LecturePrep Autopilot is the answer to:** *"What do I need to know before this lecture starts?"*

---

## What It Does

The app runs as a local web server. Every time you have a class, it automatically:

1. **Reads your calendar** — Connects to your university's ICS/Outlook calendar and identifies today's sessions
2. **Navigates Moodle** — Opens the right course page using a persistent authenticated browser session, clicks the correct section tab or accordion, and finds this week's lecture materials
3. **Downloads the slides** — Extracts and downloads only the relevant PDF or PPTX (not homework, not case studies — just the lecture slides)
4. **Summarises with AI** — Sends the content to Gemini and gets back a structured study brief: a plain-English overview, key concepts, topic-by-topic breakdown, and exact definitions to memorise
5. **Serves a dashboard** — Displays everything in a clean web UI you can open from any browser on the same machine

The whole pipeline runs in the background. By the time you sit down for coffee before class, your brief is ready.

---

## The Problem It Solves

| Before | After |
|--------|-------|
| Manually log in to Moodle every day | One-time browser authentication, reused automatically |
| Search through multiple course pages | App knows exactly which course, section, and file to fetch |
| Download and skim 80+ slides in 20 minutes | Read a 5-minute structured brief with the essentials |
| Miss a lecture because materials weren't posted yet | App detects unpublished materials and tells you clearly |
| Lose track of which topic you're on | Session tracker auto-increments after every successful run |
| Wrong slides because you clicked the wrong section | Intelligent section-scoring with per-course override rules |

---

## How It Makes You a Better Student

Preparation quality directly affects how much you retain during a lecture. When you arrive knowing the vocabulary, the high-level structure, and the key questions a topic raises, you spend class time building on a foundation rather than writing down definitions you could have read.

This tool shifts your preparation from *"did I find the right file?"* to *"what should I pay attention to today?"* It gives you:

- **Context before class** — The overview section tells you what the session is about and why it matters
- **Vocabulary in advance** — Key concepts and definitions mean you're not lost when the professor uses technical terms from slide 2
- **A map of the lecture** — The topic section breakdown means you know the structure before it unfolds, so you follow rather than transcribe
- **Time back** — 20–30 minutes of searching and skimming replaced by a 5-minute read

---

## Architecture

```
Calendar (ICS / Outlook)
        │
        ▼
  Scheduler Engine          ← Reads today's sessions from your .ics feed
        │
        ▼
   Resolver Layer           ← Playwright browser opens Moodle, navigates to the right
        │                      section/tab, scores sections, applies per-course rules
        ▼
  PDF/PPT Downloader        ← Authenticated download via browser session
        │                      Handles Moodle's mod/resource/view.php → pluginfile.php chain
        ▼
   Text Extractor           ← Parses PDF bytes, chunks content for the LLM
        │
        ▼
   AI Summariser            ← Gemini primary → ChatPDF fallback → deterministic offline
        │
        ▼
   SQLite Storage           ← Sessions, runs, resolver debug, summaries
        │
        ▼
  Express Web Server        ← Dashboard, Session detail, History, Settings
```

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js v22 + TypeScript (ESM) |
| Web server | Express |
| Browser automation | Playwright (persistent profile, authenticated) |
| Database | SQLite via `better-sqlite3` |
| PDF parsing | `pdf-parse` |
| AI summarisation | Google Gemini (`gemini-2.5-flash`) |
| Schema validation | Zod |
| Calendar | ICS/iCal (Outlook, Google Calendar) |
| Frontend | Vanilla HTML/CSS/JS (no build step) |

---

## Getting Started

### Prerequisites

- Node.js 22+
- A Google Gemini API key ([get one here](https://aistudio.google.com/app/apikey))
- Access to a Moodle-based university platform
- Your university calendar as an `.ics` URL (Outlook → "Publish to web" → ICS link)

### Installation

```bash
git clone https://github.com/<your-username>/lectureprep-autopilot.git
cd lectureprep-autopilot
npm install
```

### Configuration

Create a `.env` file in the project root:

```env
# Calendar
CALENDAR_USE_ICS=true
CALENDAR_ICS_URL=https://outlook.office365.com/owa/calendar/.../reachcalendar.ics

# Moodle
RESOLVER_USE_LIVE_MOODLE=true
MOODLE_BASE_URL=https://your-university-moodle.edu/my/

# AI
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash

# Optional fallback AI provider
# CHATPDF_API_KEY=your_chatpdf_key
# CHATPDF_SOURCE_ID=your_source_id

# Timezone (for correct "today" detection)
APP_TIMEZONE=Europe/Madrid

# Optional
SUMMARY_PROVIDER_DEFAULT=auto
ALLOW_MOCK_FALLBACK=false
```

### Moodle Authentication

The app uses a persistent Playwright browser profile so it only needs you to log in once:

```bash
npm run login:moodle
```

This opens a real browser window. Log in to Moodle normally (including any SSO/SAML steps your university uses). Close the window when done — the session is saved automatically and reused on every subsequent run.

### Run

```bash
npm run start
```

Open [http://localhost:3100](http://localhost:3100)

For development with hot reload:

```bash
npm run dev
```

---

## Course Configuration

The app learns your courses through `data/config/course-map.json`. Each entry maps a calendar event name to a Moodle course URL and optional behaviour rules:

```json
[
  {
    "courseName": "Descriptive Statistics & Probability",
    "aliases": ["Descriptive Statistics", "Statistics & Probability"],
    "url": "https://your-moodle.edu/course/view.php?id=12345",
    "slidesOnlyFilter": true,
    "startingSession": 4
  },
  {
    "courseName": "Business Law II",
    "aliases": ["Business Law"],
    "url": "https://your-moodle.edu/course/view.php?id=12346",
    "slidesOnlyFilter": true
  },
  {
    "courseName": "Accounting I",
    "aliases": ["Accounting"],
    "url": "https://your-moodle.edu/course/view.php?id=12347",
    "subsectionFilter": "concepts",
    "startingSession": 6
  }
]
```

| Field | Description |
|-------|-------------|
| `courseName` | Canonical name matched against calendar events |
| `aliases` | Alternative names the calendar might use |
| `url` | Direct Moodle course URL |
| `slidesOnlyFilter` | When `true`, only downloads materials whose title contains the word "slides" |
| `subsectionFilter` | Only downloads materials in subsections whose label contains this string |
| `startingSession` | Seeds the session tracker (auto-increments after each successful run) |

---

## Dashboard Pages

| Page | URL | Purpose |
|------|-----|---------|
| **Today** | `/` | Live view of today's sessions and their pipeline status |
| **Session detail** | `/session/:id` | Full brief, resolver debug info, override controls |
| **History** | `/history` | All past runs with status, course name, and error snippets |
| **Settings** | `/settings` | Configuration status and provider health |

---

## CLI Tools

```bash
# Run today's sessions (same as the dashboard button)
npm run run-daily

# Run a specific course and topic manually
npm run run-daily -- --course="Descriptive Statistics & Probability" --topic=4 --date=2026-03-04

# Backtest across a date range
npm run backtest -- --from=2026-03-01 --to=2026-03-10

# Debug mode (captures full Moodle HTML snapshot)
npm run run-daily -- --moodle-debug
```

---

## API Reference

The Express server exposes a REST API for programmatic control:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server health check |
| `GET` | `/api/config-status` | Current environment configuration |
| `GET` | `/api/today?date=YYYY-MM-DD` | Today's sessions and run status |
| `GET` | `/api/run-today` | Trigger today's autopilot run (GET alias) |
| `POST` | `/api/autopilot/today` | Trigger today's autopilot run |
| `POST` | `/api/session/prepare` | Prepare a specific session manually |
| `POST` | `/api/session/:id/override` | Apply a section/topic override and re-run |
| `POST` | `/api/session/:id/rerun` | Re-queue a session without overrides |
| `GET` | `/api/session/:id` | Full session detail including summary |
| `GET` | `/api/session/:id/debug` | Resolver debug trace for a session |
| `GET` | `/api/sessions?date=YYYY-MM-DD` | List sessions for a given date |
| `GET` | `/api/run/:id/status` | Live pipeline stage for a run |
| `GET` | `/api/runs/latest` | Most recent runs across all courses |
| `GET` | `/api/moodle/status` | Moodle authentication cookie freshness |

---

## AI Summary Format

Each run produces a structured JSON summary with four sections:

```json
{
  "overview": "2–3 sentence plain-English explanation of what the session covers and why it matters.",
  "keyConcepts": [
    "Term: brief definition",
    "Another term: its meaning"
  ],
  "topicSections": [
    {
      "heading": "Section heading from the slides",
      "points": [
        "Key point from this section",
        "Another key takeaway"
      ]
    }
  ],
  "keyDefinitions": [
    "Exact formula or textbook definition to memorise"
  ]
}
```

The schema is validated with Zod on every response. If the model output doesn't conform, the app retries automatically before falling back to a secondary provider.

---

## How Section Selection Works

Choosing the right lecture materials is the hardest part. Course pages contain dozens of files — past exams, case studies, readings, formulas — and the app needs to find *this week's slides* reliably.

The resolver uses a multi-factor scoring system:

- **Topic number match** — If the session tracker says "Topic 4", sections containing "Topic 4" get a large score boost
- **Freshest upload** — Professors upload the current week's slides right before class; the section with the most recently uploaded file gets a boost
- **Token overlap** — Section and resource titles are tokenised and matched against the calendar event name
- **Academic markers** — Sections titled "Topic N", "Week N", "Unit N" score higher than generic sections
- **Intro penalty** — Sections named "Introduction", "Welcome", "Syllabus" score lower

For courses that don't use numeric session labels, the **session tracker** auto-increments after every successful run, maintaining the correct "current topic" across restarts.

---

## Troubleshooting

**"Slides have not been posted yet"**
The app found the correct section but the professor hasn't uploaded the slides. Check again before class — re-run from the dashboard.

**"auth_required: Moodle session is not authenticated"**
Your Playwright browser session has expired. Run `npm run login:moodle` to re-authenticate.

**Wrong section was selected**
Use the Override panel in the session detail view to manually specify a section ID, topic number, or keyword.

**Pipeline stuck on "Resolving"**
Moodle may be slow. Check your network connection. The resolver has a 45-second timeout before failing.

---

## Project Structure

```
src/
├── adapters/
│   ├── calendar/       # ICS parser + mock calendar
│   └── llm/            # LLM provider interface
├── api/
│   └── routes.ts       # All Express endpoints
├── cli/
│   ├── backtest.ts     # Backtest runner
│   ├── login-moodle.ts # One-time Playwright login helper
│   └── run-daily.ts    # CLI entry point
├── core/
│   ├── ai/             # Gemini / ChatPDF / deterministic summarisers
│   ├── orchestrator/   # Main pipeline (resolve → download → parse → summarise)
│   ├── pdf/            # PDF download, parse, chunk
│   ├── resolver/       # Moodle browser client + DOM parser + section scorer
│   └── scheduler/      # Calendar loading + session factory
├── storage/
│   └── sqlite.ts       # All database operations
├── types/
│   └── domain.ts       # TypeScript type definitions
├── utils/              # Logging, text normalisation, course map loader
└── web/                # HTML/CSS/JS frontend (index, session, history, settings)
data/
├── config/
│   └── course-map.json # Per-course URL and behaviour rules
└── storage/
    ├── app.db          # SQLite database
    └── debug/          # Per-run JSON debug traces
```

---

## Contributing

This project was built for a specific university setup (ESADE, Barcelona) but the architecture is general-purpose. If you want to adapt it to your own Moodle instance:

1. Update `data/config/course-map.json` with your course URLs
2. Set `MOODLE_BASE_URL` to your institution's Moodle homepage
3. Set `CALENDAR_ICS_URL` to your calendar's ICS feed
4. Run `npm run login:moodle` and log in with your credentials
5. Set `GEMINI_API_KEY` and start the server

Pull requests are welcome for improvements to section scoring, additional LLM providers, or better handling of non-standard Moodle themes.

---

## License

MIT — use it, fork it, adapt it. If it helps you study, that's the point.

---

*Built out of genuine frustration with Moodle and genuine curiosity about what AI-assisted studying could look like when the logistics get out of the way.*
