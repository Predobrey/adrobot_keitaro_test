import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.config import Settings
from app.db import Base
from app.keitaro import KeitaroError
from app.models import CampaignDomain, OperationLog
from app.schemas import CampaignCreate, StreamOffersUpdate
from app.service import create_campaign, update_offers


class MockKeitaro:
    def __init__(self, *, fail_stream=None):
        self.calls = []
        self.fail_stream = fail_stream
        self.stream_calls = 0
        self.updated_offers = None

    async def offers(self):
        return [{"id": 7, "state": "active", "name": "A"}, {"id": 8, "state": "active", "name": "B"}]

    async def domains(self):
        return [{"id": 3, "state": "active", "name": "track.example"}]

    async def groups(self):
        return [{"id": 4, "name": "FORTETS"}]

    async def sources(self):
        return [{"id": 5, "name": "FORTETS"}]

    async def create_campaign(self, data):
        self.calls.append(("create_campaign", data))
        return {"id": 42, "alias": "abc123"}

    async def create_stream(self, data):
        self.stream_calls += 1
        self.calls.append(("create_stream", data))
        if self.fail_stream == self.stream_calls:
            raise KeitaroError("Mock stream failure")
        return {"id": 10 + self.stream_calls}

    async def enable_campaign(self, campaign_id):
        self.calls.append(("enable_campaign", campaign_id))
        return {"id": campaign_id}

    async def campaign(self, campaign_id):
        return {"id": campaign_id, "alias": "abc123"}

    async def streams(self, campaign_id):
        return [{"id": 11}, {"id": 12}]

    async def stream(self, stream_id):
        return {"id": stream_id, "campaign_id": 42, "schema": "landings",
                "filters": [{"name": "country"}],
                "offers": self.updated_offers if self.updated_offers is not None else
                [{"offer_id": 7, "share": 100, "state": "active"}]}

    async def update_stream_offers(self, stream_id, offers):
        self.calls.append(("update", stream_id, offers))
        self.updated_offers = offers
        return {"id": stream_id}


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


def request():
    return CampaignCreate(name="Test", geos=["AU", "MX"], offer_id=7,
                          domain_id=3, group_id=4, traffic_source_id=5)


@pytest.mark.asyncio
async def test_create_campaign_with_two_flows(db):
    tracker = MockKeitaro()
    result = await create_campaign(tracker, db, Settings(), request())
    assert result["id"] == 42
    assert result["url"] == "https://track.example/abc123"
    assert [x[0] for x in tracker.calls] == ["create_campaign", "create_stream", "create_stream", "enable_campaign"]
    assert tracker.calls[0][1]["state"] == "disabled"
    redirect = tracker.calls[1][1]
    assert redirect["type"] == "forced" and redirect["schema"] == "redirect"
    assert redirect["filters"] == [{"name": "country", "mode": "accept", "payload": ["AU", "MX"]}]
    assert redirect["action_payload"] == "https://www.google.com/"
    regular = tracker.calls[2][1]
    assert regular["type"] == "default" and regular["schema"] == "landings"
    assert regular["offers"] == [{"offer_id": 7, "share": 100, "state": "active"}]
    assert db.get(CampaignDomain, 42).hostname == "track.example"


@pytest.mark.asyncio
async def test_partial_failure_does_not_enable(db):
    tracker = MockKeitaro(fail_stream=2)
    with pytest.raises(KeitaroError):
        await create_campaign(tracker, db, Settings(), request())
    assert all(call[0] != "enable_campaign" for call in tracker.calls)
    status = db.scalar(select(OperationLog.status))
    assert status == "partial"


@pytest.mark.asyncio
async def test_update_only_offers(db):
    tracker = MockKeitaro()
    data = StreamOffersUpdate(offers=[{"offer_id": 7, "share": 50}, {"offer_id": 8, "share": 50}])
    actual = await update_offers(tracker, db, 11, data)
    assert [x["share"] for x in actual["offers"]] == [50, 50]
    assert tracker.calls == [("update", 11, data.model_dump()["offers"])]
    assert db.scalar(select(OperationLog.status)) == "success"
