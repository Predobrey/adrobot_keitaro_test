import re
import secrets

from sqlalchemy.orm import Session

from .config import Settings
from .keitaro import KeitaroClient, KeitaroError
from .models import CampaignDomain, OperationLog
from .schemas import CampaignCreate, StreamOffersUpdate


def _find(items, item_id: int, name: str):
    item = next((x for x in items if x.get("id") == item_id), None)
    if not item:
        raise KeitaroError(f"Selected {name} ID {item_id} not found in Keitaro", 422)
    return item


def _campaign_alias(name: str) -> str:
    # Keitaro requires a non-blank alias, unique enough for shared test trackers.
    prefix = re.sub(r"[^a-z0-9_-]+", "-", name.lower()).strip("-_")[:60] or "campaign"
    return f"{prefix}_{secrets.token_hex(4)}"


def _campaign_url(hostname: str, alias: str) -> str:
    name = hostname.strip().rstrip("/")
    if not name.startswith(("http://", "https://")):
        name = "https://" + name
    return f"{name}/{alias.lstrip('/')}"


def _log(db: Session, action: str, status: str, *, campaign_id=None, stream_id=None, details=""):
    db.add(OperationLog(action=action, status=status, campaign_id=campaign_id,
                        stream_id=stream_id, details=details[:500]))
    db.commit()


async def create_campaign(client: KeitaroClient, db: Session, settings: Settings, payload: CampaignCreate):
    # Read/validate before the first write to minimize abandoned campaigns.
    offer = _find(await client.offers(), payload.offer_id, "offer")
    if offer.get("state") not in (None, "active"):
        raise KeitaroError("Selected offer is not active", 422)
    domain = _find(await client.domains(), payload.domain_id, "domain")
    if domain.get("state") not in (None, "active"):
        raise KeitaroError("Selected domain is not active", 422)
    _find(await client.groups(), payload.group_id, "group")
    _find(await client.sources(), payload.traffic_source_id, "traffic source")

    campaign_id = None
    enabled = False
    try:
        campaign = await client.create_campaign({
            "name": payload.name, "alias": _campaign_alias(payload.name), "type": "position", "state": "disabled",
            "group_id": str(payload.group_id), "traffic_source_id": payload.traffic_source_id,
            # Domain binding is a campaign field in Keitaro Admin API.
            "domain_id": payload.domain_id,
            "cost_type": "CPC", "cost_value": 0,
        })
        campaign_id = int(campaign["id"])
        # Forced GEO redirect takes priority over the default offer stream.
        await client.create_stream({
            "campaign_id": campaign_id,
            "name": "Google / " + ",".join(payload.geos),
            "type": "forced", "position": 1,
            "schema": "redirect", "action_type": "http",
            "action_payload": settings.google_redirect_url,
            "filters": [{"name": "country", "mode": "accept", "payload": payload.geos}],
            "collect_clicks": True, "state": "active",
        })
        await client.create_stream({
            "campaign_id": campaign_id,
            "name": "Offers",
            "type": "default", "position": 2,
            "schema": "landings", "action_type": "http",
            "landings": [],
            "offers": [{"offer_id": payload.offer_id, "share": 100, "state": "active"}],
            "collect_clicks": True, "state": "active",
        })
        await client.enable_campaign(campaign_id)
        enabled = True
        # Read back after the write; a successful HTTP response is not enough.
        final_campaign = await client.campaign(campaign_id)
        final_streams = await client.streams(campaign_id)
        if len(final_streams) != 2:
            raise KeitaroError("Created campaign does not contain exactly two flows", 409)
        # Store the already assigned parked domain locally for UI convenience.
        db.add(CampaignDomain(campaign_id=campaign_id, domain_id=payload.domain_id,
                              hostname=domain["name"]))
        _log(db, "create_campaign", "success", campaign_id=campaign_id)
        alias = final_campaign.get("alias") or campaign.get("alias") or ""
        return {"id": campaign_id, "name": payload.name, "alias": alias,
                "domain": domain["name"], "url": _campaign_url(domain["name"], alias),
                "streams": final_streams}
    except Exception as exc:
        # Keitaro may have persisted a campaign before a later stream fails.
        # Never retry blindly; tell the operator which campaign to inspect.
        if campaign_id is not None:
            _log(db, "create_campaign", "verify" if enabled else "partial", campaign_id=campaign_id,
                 details="Inspect campaign in Keitaro; operation was not fully verified")
            if isinstance(exc, KeitaroError):
                raise KeitaroError(f"{exc}; кампания #{campaign_id} могла быть создана частично — "
                                   "проверьте её в Keitaro перед повторной попыткой", exc.status) from exc
        raise


async def update_offers(client: KeitaroClient, db: Session, stream_id: int, data: StreamOffersUpdate):
    original = await client.stream(stream_id)
    if original.get("schema") != "landings":
        raise KeitaroError("Only offer/landing streams can be edited", 422)
    offered = await client.offers()
    valid = {int(o["id"]) for o in offered if o.get("state") in (None, "active")}
    if any(o.offer_id not in valid for o in data.offers):
        raise KeitaroError("Selected offer does not exist or is archived", 422)
    # Partial PUT: only the offers change. Keitaro keeps schema, filters and landings.
    await client.update_stream_offers(stream_id, [offer.model_dump() for offer in data.offers])
    current = await client.stream(stream_id)
    expected = {o.offer_id: (o.share, o.state) for o in data.offers}
    actual = {int(o["offer_id"]): (int(o.get("share", 0)), o.get("state", "active"))
              for o in current.get("offers", [])}
    status = "success" if expected == actual else "verify"
    _log(db, "update_offers", status, campaign_id=original.get("campaign_id"),
         stream_id=stream_id, details="" if status == "success" else "Keitaro returned different offer shares")
    if status != "success":
        raise KeitaroError("Keitaro accepted update, but read-back differs. Check tracker manually", 409)
    return current
