/** Pure state transitions for the Keitaro offer editor; never perform network requests here. */
import { distribute, sharesValid, type OfferRow } from "./distribution.ts";

export interface OfferChoice {
  id: number;
  name: string;
}

export interface OfferPayloadRow {
  offer_id: number;
  share: number;
  state: "active";
}

/** Empty string is a temporary editing draft, never a valid saved percentage. */
export function parseShareInput(text: string): number | null {
  if (text === "") return null;
  if (!/^\d+$/.test(text)) throw new Error("Доля должна быть целым числом от 0 до 100%.");
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value > 100) {
    throw new Error("Доля должна быть целым числом от 0 до 100%.");
  }
  return value;
}

export function changeShare(rows: OfferRow[], id: number, value: number): OfferRow[] {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("Доля должна быть целым числом от 0 до 100%.");
  }
  const edited = rows.find((row) => row.id === id && !row.removed);
  if (!edited) {
    throw new Error("Нельзя изменить долю отсутствующего или удалённого оффера.");
  }
  // Hold the typed share fixed only while distributing the remainder.
  // Editing a number must never enable the pin button on its own.
  const working = rows.map((row) => row.id === id
    ? { ...row, share: value, locked: true } : { ...row });
  const fixedTotal = working.filter((row) => !row.removed && row.locked)
    .reduce((sum, row) => sum + row.share, 0);
  if (fixedTotal > 100) {
    throw new Error("Сумма закреплённых долей и изменённой доли не может превышать 100%.");
  }
  const distributed = distribute(working);
  return distributed.map((row) => row.id === id
    ? { ...row, locked: edited.locked } : row);
}

export function switchPin(rows: OfferRow[], id: number): OfferRow[] {
  return distribute(rows.map((row) => row.id === id && !row.removed
    ? { ...row, locked: !row.locked } : { ...row }));
}

export function switchRemoved(rows: OfferRow[], id: number): OfferRow[] {
  const current = rows.find((row) => row.id === id);
  if (!current) throw new Error("Оффер не найден в текущем потоке.");
  if (!current.removed && rows.filter((row) => !row.removed).length <= 1) {
    throw new Error("В потоке должен остаться хотя бы один активный оффер.");
  }
  return distribute(rows.map((row) => row.id === id
    ? { ...row, removed: !row.removed, locked: false, share: 0 } : { ...row }));
}

export function appendOffer(rows: OfferRow[], choice: OfferChoice): OfferRow[] {
  if (!Number.isSafeInteger(choice.id) || choice.id <= 0 || !choice.name.trim()) {
    throw new Error("Выберите доступный оффер из Keitaro.");
  }
  const existing = rows.find((row) => row.id === choice.id);
  if (existing && !existing.removed) return rows.map((row) => ({ ...row }));
  const updated = existing
    ? rows.map((row) => row.id === choice.id
      ? { ...row, name: choice.name, removed: false, locked: false, share: 0 } : { ...row })
    : [...rows, { id: choice.id, name: choice.name, share: 0, locked: false, removed: false }];
  return distribute(updated);
}

/**
 * Reconcile the current Keitaro stream with rows already seen in this browser session.
 * The tracker is authoritative for active offers and percentages, while missing
 * previously known IDs remain visible as recoverable, zero-share rows.
 * Do not use unsaved drafts as `known` unless a PUT was confirmed successful.
 */
export function reconcileLoadedOffers(known: OfferRow[], received: OfferRow[]): OfferRow[] {
  const byId = new Map(received.map((row) => [row.id, row]));
  const result: OfferRow[] = [];
  const seen = new Set<number>();
  for (const previous of known) {
    if (seen.has(previous.id)) continue;
    seen.add(previous.id);
    const current = byId.get(previous.id);
    if (current) {
      // Prefer a catalog name, falling back to the previously known name when
      // an ID is no longer present in the current catalog snapshot.
      const name = current.name === `Оффер №${current.id}` ? previous.name : current.name;
      result.push({ ...current, name, share: current.removed ? 0 : current.share, locked: false });
      byId.delete(previous.id);
    } else {
      result.push({ ...previous, removed: true, share: 0, locked: false });
    }
  }
  for (const current of byId.values()) {
    result.push({ ...current, share: current.removed ? 0 : current.share, locked: false });
  }
  return result;
}

/**
 * Keitaro stores offer shares, not editor pins. Reapply local pin preferences
 * after a server read without replacing server-authoritative share values.
 */
export function restoreSessionPins(rows: OfferRow[], pinnedIds: ReadonlySet<number>): OfferRow[] {
  return rows.map((row) => ({ ...row, locked: !row.removed && pinnedIds.has(row.id) }));
}

// Only the editor's pin preferences are persisted. Keitaro remains authoritative
// for the stream's offers, their active state, and their percentages.
export type PinStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PIN_STORAGE_PREFIX = "adrobot:offer-pins:v1:";

function validOfferId(id: unknown): id is number {
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0;
}

/** Invalid or unavailable browser storage must never break the editor. */
export function readStoredPins(storage: PinStorage, streamId: number): Set<number> {
  if (!validOfferId(streamId)) return new Set();
  try {
    const raw = storage.getItem(`${PIN_STORAGE_PREFIX}${streamId}`);
    if (!raw) return new Set();
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) return new Set();
    return new Set(decoded.filter(validOfferId));
  } catch {
    return new Set();
  }
}

/** Empty sets remove the saved entry; sharing a storage key across streams is forbidden. */
export function writeStoredPins(storage: PinStorage, streamId: number, pinnedIds: ReadonlySet<number>): void {
  if (!validOfferId(streamId)) return;
  const key = `${PIN_STORAGE_PREFIX}${streamId}`;
  const ids = [...pinnedIds].filter(validOfferId).sort((a, b) => a - b);
  try {
    if (ids.length) storage.setItem(key, JSON.stringify(ids));
    else storage.removeItem(key);
  } catch {
    // Storage can be disabled or full; keep the working in-memory pin state.
  }
}

export function resetEditor(baseline: OfferRow[]): OfferRow[] {
  return baseline.map((row) => ({ ...row }));
}

export function buildOffersPayload(rows: OfferRow[]): OfferPayloadRow[] {
  if (!sharesValid(rows)) {
    throw new Error("Нельзя сохранить поток: сумма активных долей должна составлять 100%.");
  }
  return rows.filter((row) => !row.removed)
    .map((row) => ({ offer_id: row.id, share: row.share, state: "active" }));
}
