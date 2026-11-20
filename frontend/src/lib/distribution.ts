/** Share adjustments only affect the editable stream; no writes until explicit confirmation. */
export interface OfferRow {
  id: number;
  name: string;
  share: number;
  locked: boolean;
  removed: boolean;
}

export function distribute(rows: OfferRow[]): OfferRow[] {
  const copy = rows.map((row) => ({ ...row, share: row.removed ? 0 : row.share }));
  const active = copy.filter((row) => !row.removed);
  const pinned = active.filter((row) => row.locked);
  const flexible = active.filter((row) => !row.locked);
  const pinnedTotal = pinned.reduce((sum, row) => sum + row.share, 0);
  if (pinnedTotal > 100 || pinnedTotal < 0) return copy;
  if (!flexible.length) return copy;
  const remainder = 100 - pinnedTotal;
  const each = Math.floor(remainder / flexible.length);
  let extra = remainder % flexible.length;
  for (const row of flexible) row.share = each + (extra-- > 0 ? 1 : 0);
  return copy;
}

export function sharesValid(rows: OfferRow[]): boolean {
  const active = rows.filter((row) => !row.removed);
  return active.length > 0 &&
    active.every((row) => Number.isSafeInteger(row.id) && row.id > 0) &&
    new Set(active.map((row) => row.id)).size === active.length &&
    active.every((row) => Number.isInteger(row.share) && row.share >= 0 && row.share <= 100) &&
    active.reduce((sum, row) => sum + row.share, 0) === 100;
}

/** Locked status is a client-only editing affordance and is not saved in Keitaro. */
export function offersSignature(rows: OfferRow[]): string {
  return JSON.stringify(rows.filter((row) => !row.removed)
    .map(({ id, share }) => ({ id, share })));
}
