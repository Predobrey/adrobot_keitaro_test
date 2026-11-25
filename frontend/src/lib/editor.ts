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
  if (!rows.some((row) => row.id === id && !row.removed)) {
    throw new Error("Нельзя изменить долю отсутствующего или удалённого оффера.");
  }
  const updated = rows.map((row) => row.id === id ? { ...row, share: value, locked: true } : { ...row });
  const pinnedSum = updated.filter((row) => !row.removed && row.locked)
    .reduce((sum, row) => sum + row.share, 0);
  if (pinnedSum > 100) throw new Error("Сумма закреплённых долей не может превышать 100%.");
  return distribute(updated);
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
