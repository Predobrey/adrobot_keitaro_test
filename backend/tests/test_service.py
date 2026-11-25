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
    result = await create_campaign(tracker, db, Settings(keitaro_base_url="https://tracker.example"), request())
    assert result["id"] == 42
    assert result["url"] == "https://track.example/abc123"
    assert result["admin_url"] == "https://tracker.example/admin/#!/campaign/42/main"
    assert [x[0] for x in tracker.calls] == ["create_campaign", "create_stream", "create_stream", "enable_campaign"]
    assert tracker.calls[0][1]["state"] == "disabled"
    assert tracker.calls[0][1]["alias"].startswith("test_")
    assert len(tracker.calls[0][1]["alias"]) > len("test_")
    assert tracker.calls[0][1]["domain_id"] == 3
    assert tracker.calls[0][1]["group_id"] == "4"
    assert tracker.calls[0][1]["traffic_source_id"] == 5
    redirect = tracker.calls[1][1]
    assert redirect["type"] == "forced" and redirect["schema"] == "redirect"
    assert redirect["filters"] == [{"name": "country", "mode": "accept", "payload": ["AU", "MX"]}]
    assert redirect["action_payload"] == "https://www.google.com/"
    regular = tracker.calls[2][1]
    assert regular["type"] == "default" and regular["schema"] == "landings"
    assert regular["offers"] == [{"offer_id": 7, "share": 100, "state": "active"}]
    assert db.get(CampaignDomain, 42).hostname == "track.example"


@pytest.mark.asyncio
async def test_selected_domain_is_sent_to_keitaro_not_just_stored_locally(db):
    tracker = MockKeitaro()

    async def domains():
        return [{"id": 3, "state": "active", "name": "track.example"},
                {"id": 9, "state": "active", "name": "alternate.example"}]

    tracker.domains = domains
    data = request().model_copy(update={"domain_id": 9})
    result = await create_campaign(tracker, db, Settings(), data)

    assert tracker.calls[0][1]["domain_id"] == 9
    assert result["domain"] == "alternate.example"
    assert db.get(CampaignDomain, 42).domain_id == 9


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


@pytest.mark.asyncio
async def test_alias_generated_as_safe_nonempty_unique_value(db):
    from app.service import _campaign_alias

    first = _campaign_alias("test_uhtikov_campaign1")
    second = _campaign_alias("test_uhtikov_campaign1")
    assert first.startswith("test_uhtikov_campaign1_")
    assert second != first
    assert all(char.islower() or char.isdigit() or char in "_-" for char in first)


@pytest.mark.asyncio
async def test_partial_campaign_error_mentions_id(db):
    tracker = MockKeitaro(fail_stream=1)
    with pytest.raises(KeitaroError, match="#42"):
        await create_campaign(tracker, db, Settings(), request())


@pytest.mark.asyncio
async def test_create_rejects_unrelated_streams_even_when_count_is_two(db):
    tracker = MockKeitaro()

    async def other_streams(_campaign_id):
        return [{"id": 11}, {"id": 999}]

    tracker.streams = other_streams
    with pytest.raises(KeitaroError, match="submitted flows.*#42|#42.*submitted flows"):
        await create_campaign(tracker, db, Settings(), request())
    assert db.scalar(select(OperationLog.status)) == "verify"


@pytest.mark.asyncio
async def test_created_campaign_contains_emulator_admin_link(db):
    tracker = MockKeitaro()
    settings = Settings(keitaro_base_url="https://keitaro-for-tests.etolegko.com/")
    result = await create_campaign(tracker, db, settings, request())
    assert result["admin_url"] == (
        "https://keitaro-for-tests.etolegko.com/admin/#!/campaign/42/main"
    )
    assert result["url"] == "https://track.example/abc123"
    assert result["admin_url"] != result["url"]
