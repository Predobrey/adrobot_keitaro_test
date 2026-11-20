# Adrobot — Keitaro Campaign Manager

Small FastAPI + SQLAlchemy application for the ETOLEGKO test assignment.

## Features

- **Create campaigns:** name, one or multiple ISO-2 GEO codes, existing offer, existing parked domain, campaign group, traffic source. Creates a disabled campaign, then two flows: `forced` country-filtered HTTP redirect to Google and `default` stream with an offer. Enables the campaign only after both flows are created.
- **Edit offer streams:** list campaigns, select stream, add/remove/restore offers before saving; rebalance whole-number shares; pin an offer share; Cancel or Push to KT. Only active offers are sent when saving. The UI rereads Keitaro after a save.
- **Persistence:** SQLAlchemy keeps the selected domain association for campaign URLs and an operation log. Keitaro remains the source of truth for campaign/stream/offer data.
- **Safety:** API key is server-side. No writes on page load. Campaign creation starts disabled to avoid serving incomplete routing. If creation fails midway, a disabled campaign may remain in Keitaro and should be inspected manually.

## Requirements

- Python 3.12+ (3.11 is also expected to work)
- Keitaro Admin API access; a pre-existing active domain, group, traffic source and offer.
- This app is intended for **local use**, not public deployment without authentication and TLS.

## Setup (Windows PowerShell)

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
# Edit .env: enter the tracker base URL and API key; never commit .env.
alembic upgrade head
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>. API docs at <http://127.0.0.1:8000/docs>.

Linux/macOS: `python3 -m venv .venv; source .venv/bin/activate; pip install -r requirements.txt; cp .env.example .env; alembic upgrade head; uvicorn app.main:app --reload`.

## Environment

| Variable | Description |
| --- | --- |
| `KEITARO_BASE_URL` | Tracker origin, e.g. `https://tracker.example` (without `/admin_api/v1`) |
| `KEITARO_API_KEY` | Keitaro Admin API key (only in `.env`) |
| `DATABASE_URL` | Local SQLite by default; SQLAlchemy URL |
| `GOOGLE_REDIRECT_URL` | Redirect destination, defaults to `https://www.google.com/` |

Keitaro calls use header `Api-Key`. Outside localhost, the application requires an HTTPS tracker URL.

## Test

```powershell
pytest -q
```

Tests use mocked Keitaro responses; a live tracker isn't required. Before submitting, verify creating a campaign and editing offers against an **authorized test campaign** in Keitaro.

## Design notes / boundaries

- Domain is selected from **existing parked domains** via `GET /domains`. Keitaro's publicly documented `POST /campaigns` schema has no `domain_id`; the selected host is stored locally to construct the campaign link with the campaign alias. This **does not change domain parking or default domain settings** in Keitaro.
- Geo filter uses the Keitaro `country` filter, `accept` mode and an array of ISO-2 codes. Flow priority is set by `forced` and `default` types with position rotation.
- First flow uses `schema=redirect`, `action_type=http`, `action_payload=https://www.google.com/` (HTTP redirect).
- Second flow uses `schema=landings` with empty landings and one 100% offer; existing offers are updated with partial `PUT /streams/{id}` containing only the `offers` array, leaving unrelated stream fields untouched.
- Offer shares are percentages, not normalized float probabilities. For unlocked offers remaining integer percentage points are spread evenly and remainder assigned from top to bottom (e.g., 34/33/33). Pinned shares are left unchanged.
- The UI doesn't implement editing filters, domains, campaign source, monitoring, roles, account management or analytics. Those are outside assignment scope.
- If a live Keitaro API version uses a different redirect / country-filter payload, inspect one corresponding request in Keitaro **Network → Fetch/XHR → Payload** and adjust the mapping in `app/service.py`. No live access was available during initial implementation.

## API routes

`GET /api/health`, `GET /api/meta`, `GET /api/campaigns`, `POST /api/campaigns`, `GET /api/campaigns/{id}/streams`, `GET /api/streams/{id}`, `PUT /api/streams/{id}/offers`.

## Official docs

- <https://docs.keitaro.io/en/development/admin-api.html>
- <https://admin-api.docs.keitaro.io/>
