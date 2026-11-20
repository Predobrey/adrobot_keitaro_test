# Adrobot — Keitaro Campaign Manager

FastAPI + SQLAlchemy backend with a Next.js (App Router) + TypeScript frontend.

## Run locally (Windows PowerShell)

**Terminal 1 — Backend (FastAPI on port 8000)**

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
# Fill in KEITARO_BASE_URL and KEITARO_API_KEY in backend/.env
alembic upgrade head
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

**Terminal 2 — Frontend (Next.js on port 3000)**

```powershell
cd frontend
npm install
npm run dev
```

Open **http://127.0.0.1:3000** (the Next.js UI). FastAPI docs remain at http://127.0.0.1:8000/docs.

Node.js 20.9+ is required for Next.js. Use Node.js 22 LTS when available.
The frontend proxies `/api/*` to FastAPI via `next.config.ts`. For a non-default backend address,
set `API_PROXY_TARGET` in `frontend/.env.local` (server side, e.g. `http://127.0.0.1:8000`) and restart Next.js.
Do **not** put `KEITARO_API_KEY` into frontend env variables or commit either `.env` file.

## Verification

```powershell
# In backend/, with .venv activated:
pytest -q

# In frontend/:
npm run typecheck
npm test
npm run build
```

Both create and edit operations require explicit confirmation before sending writes to Keitaro.
**Verify against an authorized test campaign** before using any production campaign.
Keitaro remains the source of truth for campaigns, streams, and offers.
SQLAlchemy stores the selected domain association and operation history.

For details about migration commands, API endpoints, and integration limitations,
see [backend/README.md](backend/README.md).

## Scope

- Campaign creation: name, ISO-2 GEO list, offer, domain, group, and traffic source. Creates two streams (GEO → Google and fallback → offer).
- Offer editor: select existing campaign/stream, add/remove/restore offers, equalize or pin shares, Cancel, Push to Keitaro.
- API access: all browser traffic is same-origin on Next.js. FastAPI makes authenticated Keitaro Admin API requests.
- Intended for local test-assignment use; add authentication and TLS before making it publicly accessible.

The original static FastAPI interface remains available at http://127.0.0.1:8000 for reference; the primary UI is Next.js on port 3000.
