# Spark Variant — Architecture Guide

The Spark variant is a specialized build of World Monitor focused on **Chinese intelligence + financial analysis** for enterprise users.

## Build & Run

```bash
npm run dev:spark          # Development server
npm run build:spark        # Production build
npm run test:e2e:spark     # E2E tests
```

Environment variable `VITE_VARIANT=spark` activates the variant. The build uses the same Vite pipeline as other variants (full, tech, finance, happy).

## Theme

Defined in `src/styles/spark-theme.css`. Activated via `[data-variant="spark"]` on `<html>`.

- **Primary**: `#0C1222` (deep navy)
- **Accent**: `#E8A838` (amber gold)
- **Elevated**: `#1A2840`

## Panel Architecture

All Cn\* panels extend `Panel` base class (`src/components/Panel.ts`) which provides:

- `showLoading(msg)` / `showError(msg)` / `showRetrying(msg)`
- `setDataBadge('live' | 'cached' | 'unavailable')`
- `isAbortError(err)` for AbortController cleanup
- Resize handles (row + column span)
- New items badge with pulse animation

### Panel List

| Panel | File | Description |
|-------|------|-------------|
| CnPolicyPanel | `cn-policy/` | Policy database: overview, live feed, industry insights, calendar, stats |
| CnBriefPanel | `CnBriefPanel.ts` | AI-generated daily investment brief |
| CnMarketPanel | `CnMarketPanel.ts` | A-share market data (indices, sectors, northbound flow) |
| CnSentimentPanel | `CnSentimentPanel.ts` | Market sentiment gauge + factor breakdown |
| CnMoodPanel | `CnMoodPanel.ts` | Social media mood (Weibo/Zhihu/Xiaohongshu + multi-platform) |
| CnHotEventsPanel | `CnHotEventsPanel.ts` | Hot events with stock impact |
| CnResearchPanel | `CnResearchPanel.ts` | Research reports (DB + Eastmoney + uploads) |
| CnInsightsPanel | `CnInsightsPanel.ts` | Cross-domain correlation signals + trade ideas |
| CnRagPanel | `CnRagPanel.ts` | RAG-powered AI research assistant (chat UI) |
| CnAlertPanel | `CnAlertPanel.ts` | Three-tier alert inbox (FLASH/PRIORITY/ROUTINE) |
| CnReportViewer | `CnReportViewer.ts` | Full-page report viewer |
| CnProfileModal | `CnProfileModal.ts` | Enterprise profile setup modal |
| CnDeltaBanner | `CnDeltaBanner.ts` | Delta tracking banner (policy changes) |

## Data Flow

```
Browser → cnFetch() → cn-intel-service (port 8078)
                         ├── /api/cn/gov-news      → Policy news
                         ├── /api/cn/brief          → AI investment brief
                         ├── /api/cn/market         → Market data
                         ├── /api/cn/sentiment      → Sentiment scores
                         ├── /api/cn/mood           → Social media mood
                         ├── /api/cn/hot-events     → Hot events
                         ├── /api/cn/research       → Research reports
                         ├── /api/cn/insights/*     → Cross-domain signals
                         ├── /api/cn/rag/*          → RAG assistant
                         ├── /api/cn/alerts/*       → Alert system (SSE)
                         ├── /api/cn/profile        → User profile CRUD
                         ├── /api/cn/enterprise/*   → Morning brief
                         ├── /api/cn/industry/*     → Industry analysis
                         ├── /api/cn/policy/*       → Policy search/stats/calendar
                         └── /api/auth/*            → Authentication
```

## Authentication Flow

1. User registers at `register.html` → application submitted (status: pending)
2. Admin reviews at `admin.html` → approve/reject
3. User logs in at `login.html` → JWT token stored in `localStorage('wm_token')`
4. `main.ts` checks token on load → redirects to login if missing/invalid
5. `cnFetch()` auto-attaches `Bearer` token, redirects on 401

## Admin Workflow

`admin.html` → `src/admin-main.ts`:

- **Applications tab**: View pending registrations, approve/reject with notes
- **Users tab**: Manage approved users, set subscription expiry, suspend/restore, reset passwords
- **Create Account tab**: Admin can directly create user accounts

## SSE Alerts

`src/services/cn-alerts.ts` connects to `GET /api/cn/alerts/stream` via Server-Sent Events:

- Auto-reconnect on disconnect (5s delay)
- Three tiers: FLASH (urgent), PRIORITY (important), ROUTINE (normal)
- Mark-read tracking via `POST /api/cn/alerts/read`
- Alert panel (`CnAlertPanel`) renders as dropdown from bell icon

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_VARIANT` | Build variant | `full` |
| `VITE_CN_INTEL_BASE` | cn-intel-service URL | `http://localhost:8078` |
| `VITE_SENTRY_DSN` | Sentry error tracking DSN | (none) |

## Backend: cn-intel-service

Python/Flask service at `cn-intel-service/`:

```
cn-intel-service/
├── app.py              # Flask application entry
├── config.py           # Configuration
├── api/                # Route handlers (24 modules)
│   ├── auth.py         # Login/register/logout
│   ├── admin.py        # Admin CRUD
│   ├── gov_news.py     # Policy news
│   ├── brief.py        # AI daily brief
│   ├── market.py       # Market data
│   ├── sentiment.py    # Sentiment analysis
│   ├── mood.py         # Social media mood
│   ├── hot_events.py   # Hot events
│   ├── research.py     # Research reports
│   ├── insights.py     # Cross-domain analysis
│   ├── rag.py          # RAG assistant
│   ├── alerts.py       # Alert SSE stream
│   ├── profile.py      # User profile
│   ├── industry.py     # Industry analysis
│   └── ...
├── services/           # Business logic
│   ├── alert_engine.py # Alert generation + dedup
│   ├── rag_engine.py   # RAG retrieval
│   ├── daily_brief.py  # Brief generation
│   ├── policy_store.py # Policy storage
│   └── ...
└── scripts/
    └── daily_pipeline.py
```

## PDF Export

`src/utils/pdf-export.ts` provides `exportToPDF(element, filename)`:

- Dynamically imports `jspdf` + `html2canvas` (no impact on initial bundle)
- Renders element to canvas at 2x scale
- Generates multi-page A4 PDF
- Available on CnPolicyPanel overview, CnBriefPanel, CnReportViewer
