export interface MetaItem {
  id: number;
  name: string;
  state?: string;
}
export interface Campaign {
  id: number;
  name: string;
  state?: string;
  alias?: string;
  adrobot_domain?: string;
}
export interface StreamOffer {
  offer_id: number;
  share: number;
  state: string;
}
export interface Stream {
  id: number;
  campaign_id?: number;
  name: string;
  schema: string;
  state?: string;
  offers?: StreamOffer[];
}
export interface Meta {
  offers: MetaItem[];
  domains: MetaItem[];
  groups: MetaItem[];
  sources: MetaItem[];
}
export interface CreatedCampaign {
  id: number;
  name: string;
  alias: string;
  domain: string;
  url: string;
  streams: Stream[];
}
export interface CampaignPayload {
  name: string;
  geos: string[];
  offer_id: number;
  domain_id: number;
  group_id: number;
  traffic_source_id: number;
}

function humanizeDetail(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => {
    if (typeof item !== "object" || item === null) return String(item);
    const message = "msg" in item ? String(item.msg) : "Validation failed";
    const path = "loc" in item && Array.isArray(item.loc) ? item.loc.join(".") : "";
    return path ? `${path}: ${message}` : message;
  }).join("; ");
  return "Request failed";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
      cache: "no-store",
    });
  } catch {
    throw new Error("Cannot reach FastAPI. Check that the backend is running on port 8000.");
  }
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data ? data.detail : null;
    throw new Error(detail ? humanizeDetail(detail) : `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
