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

const KNOWN_ERRORS: Record<string, string> = {
  "Configure KEITARO_BASE_URL and KEITARO_API_KEY in .env": "Укажите адрес и API-ключ Keitaro в backend/.env.",
  "Keitaro must use HTTPS (except localhost)": "Для Keitaro нужен адрес HTTPS (кроме localhost).",
  "Cannot reach Keitaro tracker": "Не удалось подключиться к серверу Keitaro.",
  "Keitaro redirected API request; check tracker URL and access": "Keitaro перенаправил API-запрос. Проверьте адрес панели и права доступа.",
  "Keitaro returned non-JSON response": "Keitaro вернул ответ не в формате JSON.",
  "Selected offer is not active": "Выбранный оффер неактивен.",
  "Selected domain is not active": "Выбранный домен неактивен.",
  "Created campaign does not contain exactly two flows": "В созданной кампании обнаружено не два потока. Проверьте кампанию в Keitaro.",
  "Only offer/landing streams can be edited": "Можно редактировать только потоки с офферами/лендингами.",
  "Selected offer does not exist or is archived": "Оффер не найден или находится в архиве.",
  "Keitaro accepted update, but read-back differs. Check tracker manually": "Keitaro принял изменения, но проверка вернула другие значения. Проверьте поток вручную.",
};

function translateError(message: string): string {
  if (KNOWN_ERRORS[message]) return KNOWN_ERRORS[message];
  const missing = message.match(/^Selected (offer|domain|group|traffic source) ID (\d+) not found in Keitaro$/);
  if (missing) {
    const fieldNames: Record<string, string> = { offer: "Оффер", domain: "Домен", group: "Группа", "traffic source": "Источник трафика" };
    const field = fieldNames[missing[1]] ?? "Объект";
    return `${field} №${missing[2]} не найден в Keitaro.`;
  }
  const http = message.match(/^Keitaro HTTP (\d+)(?:: (.+))?$/);
  if (http) return `Ошибка Keitaro (HTTP ${http[1]})${http[2] ? `: ${http[2]}` : "."}`;
  return message;
}

function humanizeDetail(value: unknown): string {
  if (typeof value === "string") return translateError(value);
  if (Array.isArray(value)) return value.map((item) => {
    if (typeof item !== "object" || item === null) return String(item);
    const message = "msg" in item ? String(item.msg) : "Ошибка проверки данных";
    const path = "loc" in item && Array.isArray(item.loc) ? item.loc.join(".") : "";
    return path ? `${path}: ${message}` : message;
  }).join("; ");
  return "Не удалось выполнить запрос";
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
    throw new Error("Не удаётся подключиться к FastAPI. Проверьте, что backend запущен на порту 8000.");
  }
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    const detail = data && typeof data === "object" && "detail" in data ? data.detail : null;
    throw new Error(detail ? humanizeDetail(detail) : `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
