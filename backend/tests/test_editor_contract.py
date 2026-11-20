"""Contract tests with a fake Keitaro. None of these tests touch the shared tracker."""
import json

import httpx
import pytest
from pydantic import ValidationError
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.config import Settings
from app.db import Base
from app.keitaro import KeitaroClient, KeitaroError
from app.main import app, get_client, get_db
from app.models import OperationLog
from app.schemas import StreamOffersUpdate
from app.service import update_offers


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()


class FakeTracker:
    def __init__(self):
        self.offer_list = [
            {"id": 101, "name": "Test A", "state": "active"},
            {"id": 102, "name": "Test B", "state": "active"},
            {"id": 103, "name": "Test C", "state": "active"},
            {"id": 104, "name": "Archived", "state": "archived"},
        ]
        self.stream_data = {
            "id": 25, "campaign_id": 45, "schema": "landings", "type": "default",
            "position": 2, "filters": [{"name": "country", "mode": "reject", "payload": ["AU"]}],
            "landings": [], "action_type": "http", "state": "active",
            "offers": [{"offer_id": 101, "share": 100, "state": "active"}],
        }
        self.put_calls = []
        self.reject_put = False
        self.corrupt_readback = False
        self.corrupt_filters = False

    async def offers(self):
        return self.offer_list

    async def stream(self, stream_id):
        assert stream_id == 25
        snapshot = json.loads(json.dumps(self.stream_data))
        if self.corrupt_readback and self.put_calls:
            snapshot["offers"] = [{"offer_id": 101, "share": 100, "state": "active"}]
        if self.corrupt_filters and self.put_calls:
            snapshot["filters"] = []
        return snapshot

    async def update_stream_offers(self, stream_id, offers):
        assert stream_id == 25
        if self.reject_put:
            raise KeitaroError("Keitaro HTTP 403: PUT streams/25 — Forbidden", 502)
        self.put_calls.append(json.loads(json.dumps(offers)))
        self.stream_data["offers"] = json.loads(json.dumps(offers))
        return {"id": stream_id}


def data(*shares):
    return StreamOffersUpdate(offers=[{"offer_id": 101 + index, "share": share, "state": "active"}
                                      for index, share in enumerate(shares)])


@pytest.mark.asyncio
async def test_two_offers_are_saved_and_read_back_exactly(db):
    client = FakeTracker()
    result = await update_offers(client, db, 25, data(50, 50))
    assert [o["share"] for o in result["offers"]] == [50, 50]
    assert client.put_calls == [[
        {"offer_id": 101, "share": 50, "state": "active"},
        {"offer_id": 102, "share": 50, "state": "active"},
    ]]
    log = db.scalar(select(OperationLog))
    assert log.status == "success" and log.campaign_id == 45 and log.stream_id == 25


@pytest.mark.asyncio
async def test_three_offers_are_saved_at_34_33_33(db):
    client = FakeTracker()
    await update_offers(client, db, 25, data(34, 33, 33))
    assert [x["share"] for x in client.put_calls[0]] == [34, 33, 33]


@pytest.mark.asyncio
async def test_remove_offers_sends_only_remaining_active_ids(db):
    client = FakeTracker()
    client.stream_data["offers"] = [
        {"offer_id": 101, "share": 34, "state": "active"},
        {"offer_id": 102, "share": 33, "state": "active"},
        {"offer_id": 103, "share": 33, "state": "active"},
    ]
    await update_offers(client, db, 25, StreamOffersUpdate(offers=[
        {"offer_id": 101, "share": 50}, {"offer_id": 103, "share": 50},
    ]))
    assert [x["offer_id"] for x in client.put_calls[0]] == [101, 103]
    assert all(x["share"] == 50 for x in client.put_calls[0])


@pytest.mark.asyncio
async def test_restore_offer_redistributes_and_can_be_saved(db):
    client = FakeTracker()
    await update_offers(client, db, 25, data(50, 50))
    assert [x["offer_id"] for x in client.stream_data["offers"]] == [101, 102]
    await update_offers(client, db, 25, data(34, 33, 33))
    assert [x["offer_id"] for x in client.stream_data["offers"]] == [101, 102, 103]
    assert sum(x["share"] for x in client.stream_data["offers"]) == 100


@pytest.mark.asyncio
async def test_offers_update_does_not_touch_stream_routing_fields(db):
    client = FakeTracker()
    before = await client.stream(25)
    after = await update_offers(client, db, 25, data(50, 50))
    for key in ("filters", "landings", "schema", "campaign_id", "type", "position", "action_type", "state"):
        assert after[key] == before[key]


@pytest.mark.asyncio
async def test_unexpected_filter_changes_are_detected_on_readback(db):
    client = FakeTracker()
    client.corrupt_filters = True
    with pytest.raises(KeitaroError, match="read-back differs"):
        await update_offers(client, db, 25, data(50, 50))
    assert db.scalar(select(OperationLog.status)) == "verify"


@pytest.mark.asyncio
async def test_different_saved_shares_are_detected_on_readback(db):
    client = FakeTracker()
    client.corrupt_readback = True
    with pytest.raises(KeitaroError, match="read-back differs"):
        await update_offers(client, db, 25, data(50, 50))
    assert db.scalar(select(OperationLog.status)) == "verify"


@pytest.mark.asyncio
async def test_keitaro_write_denial_returns_error_without_success_log(db):
    client = FakeTracker()
    client.reject_put = True
    with pytest.raises(KeitaroError, match="403"):
        await update_offers(client, db, 25, data(50, 50))
    assert client.put_calls == []
    assert db.scalar(select(OperationLog)) is None


@pytest.mark.asyncio
async def test_only_landing_schema_is_editable(db):
    client = FakeTracker()
    client.stream_data["schema"] = "redirect"
    with pytest.raises(KeitaroError, match="Only offer/landing streams"):
        await update_offers(client, db, 25, data(50, 50))
    assert client.put_calls == []


@pytest.mark.asyncio
async def test_unknown_or_archived_offers_cannot_be_written(db):
    client = FakeTracker()
    for offer_id in (104, 9999):
        with pytest.raises(KeitaroError, match="does not exist or is archived"):
            await update_offers(client, db, 25, StreamOffersUpdate(offers=[
                {"offer_id": 101, "share": 50}, {"offer_id": offer_id, "share": 50},
            ]))
    assert not client.put_calls


@pytest.mark.parametrize("payload", [
    [],
    [{"offer_id": 101, "share": 10}],
    [{"offer_id": 101, "share": 50}, {"offer_id": 102, "share": 49}],
    [{"offer_id": 101, "share": 50}, {"offer_id": 101, "share": 50}],
    [{"offer_id": 101, "share": 100, "state": "disabled"}],
    [{"offer_id": 101, "share": 100}, {"offer_id": 102, "share": 5, "state": "disabled"}],
    [{"offer_id": 101, "share": 101}],
    [{"offer_id": 101, "share": -1}],
    [{"offer_id": 101, "share": 50.5}, {"offer_id": 102, "share": 49.5}],
])
def test_invalid_distribution_rejected_before_network(payload):
    with pytest.raises(ValidationError):
        StreamOffersUpdate(offers=payload)


@pytest.mark.asyncio
async def test_stream_put_is_offers_only_and_api_key_is_a_header():
    calls = []

    def handler(request: httpx.Request):
        calls.append(request)
        return httpx.Response(200, json={"id": 25})

    client = KeitaroClient(
        Settings(keitaro_base_url="https://keitaro.example", keitaro_api_key="test-secret"),
        transport=httpx.MockTransport(handler),
    )
    offers = [{"offer_id": 101, "share": 100, "state": "active"}]
    await client.update_stream_offers(25, offers)
    req = calls[0]
    assert req.method == "PUT"
    assert str(req.url) == "https://keitaro.example/admin_api/v1/streams/25"
    assert req.headers["Api-Key"] == "test-secret"
    assert json.loads(req.content) == {"offers": offers}
    assert b"test-secret" not in req.content


@pytest.mark.asyncio
async def test_editor_endpoint_updates_only_our_fake_tracker(db):
    tracker = FakeTracker()
    app.dependency_overrides[get_client] = lambda: tracker
    app.dependency_overrides[get_db] = lambda: db
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-test") as client:
            response = await client.put("/api/streams/25/offers", json={"offers": [
                {"offer_id": 101, "share": 50}, {"offer_id": 102, "share": 50},
            ]})
        assert response.status_code == 200
        assert [x["share"] for x in response.json()["offers"]] == [50, 50]
        assert len(tracker.put_calls) == 1
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_editor_endpoint_invalid_payload_cannot_write(db):
    tracker = FakeTracker()
    app.dependency_overrides[get_client] = lambda: tracker
    app.dependency_overrides[get_db] = lambda: db
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-test") as client:
            response = await client.put("/api/streams/25/offers", json={"offers": [
                {"offer_id": 101, "share": 10},
            ]})
        assert response.status_code == 422
        assert tracker.put_calls == []
    finally:
        app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_editor_endpoint_error_propagates_without_writing(db):
    tracker = FakeTracker()
    tracker.reject_put = True
    app.dependency_overrides[get_client] = lambda: tracker
    app.dependency_overrides[get_db] = lambda: db
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local-test") as client:
            response = await client.put("/api/streams/25/offers", json={"offers": [
                {"offer_id": 101, "share": 100},
            ]})
        assert response.status_code == 502
        assert "403" in response.json()["detail"]
        assert tracker.put_calls == []
    finally:
        app.dependency_overrides.clear()
