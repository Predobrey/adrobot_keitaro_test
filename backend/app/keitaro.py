import logging

import httpx

from .config import Settings

logger = logging.getLogger(__name__)


class KeitaroError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.status = status


def _error_details(body: object) -> str:
    """Extract short, useful Keitaro validation messages without dumping the response."""
    if not isinstance(body, dict):
        return ""

    errors = body.get("errors")
    if isinstance(errors, dict):
        entries = []
        for field, messages in list(errors.items())[:4]:
            if isinstance(messages, list):
                messages = ", ".join(str(msg) for msg in messages[:2])
            entries.append(f"{field}: {messages}")
        return "; ".join(entries)[:400]
    if isinstance(errors, list):
        entries = []
        for item in errors[:4]:
            if isinstance(item, dict):
                field = item.get("field") or item.get("path") or item.get("name") or ""
                msg = item.get("message") or item.get("msg") or item.get("error") or ""
                entries.append(f"{field}: {msg}" if field else str(msg))
            else:
                entries.append(str(item))
        return "; ".join(entries)[:400]

    for key in ("detail", "message", "error"):
        value = body.get(key)
        if isinstance(value, str):
            return value[:400]
        if isinstance(value, dict):
            return _error_details({"errors": value})
        if isinstance(value, list):
            return _error_details({"errors": value})
    return ""


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
                # Show the failed operation and validation fields, never headers or raw HTML.
                detail = ""
                try:
                    detail = _error_details(response.json())
                except ValueError:
                    pass
                if self.settings.keitaro_api_key:
                    detail = detail.replace(self.settings.keitaro_api_key, "[скрыто]")
                operation = f"{method.upper()} {path.lstrip('/')}"
                message = f"Keitaro HTTP {response.status_code}: {operation}"
                if detail:
                    message += f" — {detail}"
                raise KeitaroError(message, 502)
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
