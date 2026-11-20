import logging

import httpx

from .config import Settings

logger = logging.getLogger(__name__)


class KeitaroError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


class KeitaroClient:
    def __init__(self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None):
        self.settings = settings
        self.transport = transport

    async def request(self, method: str, path: str, *, json=None, params=None):
        if not self.settings.configured:
            raise KeitaroError("Configure KEITARO_BASE_URL and KEITARO_API_KEY in .env", 503)
        base = self.settings.keitaro_base_url.rstrip("/")
        # HTTPS by default for credentials; allow localhost HTTP for local test trackers only.
        if not base.startswith("https://") and not base.startswith(("http://localhost", "http://127.0.0.1")):
            raise KeitaroError("Keitaro must use HTTPS (except localhost)", 503)
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(20),
            follow_redirects=False,
            transport=self.transport,
            headers={"Api-Key": self.settings.keitaro_api_key, "Accept": "application/json"},
        ) as client:
            try:
                response = await client.request(
                    method, f"{base}/admin_api/v1/{path.lstrip('/')}", json=json, params=params
                )
            except httpx.RequestError as exc:
                logger.warning("Keitaro connection error: %s", type(exc).__name__)
                raise KeitaroError("Cannot reach Keitaro tracker") from exc
            if response.is_redirect:
                raise KeitaroError("Keitaro redirected API request; check tracker URL and access", 502)
            if response.status_code >= 400:
                # Do not forward arbitrary tracker HTML or secret-bearing debug dumps to the UI.
                detail = ""
                try:
                    body = response.json()
                    if isinstance(body, dict):
                        detail = str(body.get("error") or body.get("message") or "")[:250]
                except ValueError:
                    pass
                raise KeitaroError(f"Keitaro HTTP {response.status_code}" + (f": {detail}" if detail else ""), 502)
            try:
                return response.json()
            except ValueError as exc:
                raise KeitaroError("Keitaro returned non-JSON response") from exc

    async def campaigns(self):
        return await self.request("GET", "campaigns", params={"limit": 1000})

    async def offers(self):
        return await self.request("GET", "offers")

    async def domains(self):
        return await self.request("GET", "domains")

    async def groups(self):
        return await self.request("GET", "groups", params={"type": "campaigns"})

    async def sources(self):
        return await self.request("GET", "traffic_sources")

    async def streams(self, campaign_id: int):
        return await self.request("GET", f"campaigns/{campaign_id}/streams")

    async def stream(self, stream_id: int):
        return await self.request("GET", f"streams/{stream_id}")

    async def campaign(self, campaign_id: int):
        return await self.request("GET", f"campaigns/{campaign_id}")

    async def create_campaign(self, data: dict):
        return await self.request("POST", "campaigns", json=data)

    async def create_stream(self, data: dict):
        return await self.request("POST", "streams", json=data)

    async def enable_campaign(self, campaign_id: int):
        return await self.request("POST", f"campaigns/{campaign_id}/enable")

    async def update_stream_offers(self, stream_id: int, offers: list[dict]):
        return await self.request("PUT", f"streams/{stream_id}", json={"offers": offers})
