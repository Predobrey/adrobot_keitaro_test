from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings, get_settings
from .db import get_db
from .keitaro import KeitaroClient, KeitaroError
from .models import CampaignDomain
from .schemas import CampaignCreate, StreamOffersUpdate
from .service import create_campaign, update_offers


app = FastAPI(title="Adrobot", version="1.0.0")
PUBLIC = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=PUBLIC), name="static")


def get_client(settings: Settings = Depends(get_settings)):
    return KeitaroClient(settings)


@app.exception_handler(KeitaroError)
async def handle_keitaro_error(_request, exc: KeitaroError):
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=exc.status, content={"detail": str(exc)})


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(PUBLIC / "index.html")


@app.get("/api/health")
async def health(settings: Settings = Depends(get_settings)):
    return {"status": "ok", "keitaro_configured": settings.configured}


@app.get("/api/meta")
async def meta(client: KeitaroClient = Depends(get_client)):
    # Provide drop-down data from Keitaro, not locally invented IDs.
    return {
        "offers": await client.offers(),
        "domains": await client.domains(),
        "groups": await client.groups(),
        "sources": await client.sources(),
    }


@app.get("/api/campaigns")
async def campaigns(client: KeitaroClient = Depends(get_client), db: Session = Depends(get_db)):
    items = await client.campaigns()
    selected = {x.campaign_id: x for x in db.scalars(select(CampaignDomain)).all()}
    for item in items:
        match = selected.get(item.get("id"))
        if match:
            item["adrobot_domain"] = match.hostname
    return items


@app.post("/api/campaigns", status_code=201)
async def create(body: CampaignCreate, client: KeitaroClient = Depends(get_client),
                 settings: Settings = Depends(get_settings), db: Session = Depends(get_db)):
    return await create_campaign(client, db, settings, body)


@app.get("/api/campaigns/{campaign_id}/streams")
async def streams(campaign_id: int, client: KeitaroClient = Depends(get_client)):
    return await client.streams(campaign_id)


@app.get("/api/streams/{stream_id}")
async def stream(stream_id: int, client: KeitaroClient = Depends(get_client)):
    return await client.stream(stream_id)


@app.put("/api/streams/{stream_id}/offers")
async def save_offers(stream_id: int, body: StreamOffersUpdate,
                      client: KeitaroClient = Depends(get_client), db: Session = Depends(get_db)):
    return await update_offers(client, db, stream_id, body)
