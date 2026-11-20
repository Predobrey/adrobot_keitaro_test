import httpx
import pytest

from app.config import Settings
from app.keitaro import KeitaroClient, KeitaroError


@pytest.mark.asyncio
async def test_uses_api_key_and_expected_path():
    calls = []

    def handler(request: httpx.Request):
        calls.append(request)
        return httpx.Response(200, json=[{"id": 1, "name": "Demo"}])

    settings = Settings(keitaro_base_url="https://tracker.example", keitaro_api_key="secret")
    client = KeitaroClient(settings, transport=httpx.MockTransport(handler))
    result = await client.offers()
    assert result == [{"id": 1, "name": "Demo"}]
    assert calls[0].headers["Api-Key"] == "secret"
    assert str(calls[0].url) == "https://tracker.example/admin_api/v1/offers"


@pytest.mark.asyncio
async def test_keitaro_http_error_is_sanitized():
    settings = Settings(keitaro_base_url="https://tracker.example", keitaro_api_key="secret")
    client = KeitaroClient(settings, transport=httpx.MockTransport(
        lambda _req: httpx.Response(401, json={"error": "Access denied"})
    ))
    with pytest.raises(KeitaroError) as exc:
        await client.offers()
    assert "401" in str(exc.value)
    assert "secret" not in str(exc.value)


@pytest.mark.asyncio
async def test_unconfigured_tracker_is_rejected():
    client = KeitaroClient(Settings(keitaro_base_url="", keitaro_api_key=""))
    with pytest.raises(KeitaroError) as exc:
        await client.offers()
    assert exc.value.status == 503
