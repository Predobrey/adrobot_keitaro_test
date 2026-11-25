import { test } from "node:test";
import assert from "node:assert/strict";
import { appendOffer, buildOffersPayload, changeShare, parseShareInput, readStoredPins, reconcileLoadedOffers, resetEditor, restoreSessionPins, switchPin, switchRemoved, writeStoredPins } from "./editor.ts";
import { offersSignature, sharesValid, type OfferRow } from "./distribution.ts";

const row = (id: number, share = 0): OfferRow => ({
  id, name: `Тестовый оффер #${id}`, share, locked: false, removed: false,
});

test("adding a second and third offer rebalances 100/0 to 50/50 and 34/33/33", () => {
  const first = [row(1, 100)];
  const second = appendOffer(first, { id: 2, name: "Второй" });
  const third = appendOffer(second, { id: 3, name: "Третий" });
  assert.deepEqual(second.map((r) => r.share), [50, 50]);
  assert.deepEqual(third.map((r) => r.share), [34, 33, 33]);
  assert.deepEqual(first.map((r) => r.share), [100], "original state is not mutated");
});

test("adding an already active ID never duplicates an offer", () => {
  const result = appendOffer([row(1, 100)], { id: 1, name: "Повтор" });
  assert.deepEqual(result.map((r) => r.id), [1]);
  assert.equal(result[0].share, 100);
});

test("adding a previously removed offer restores the existing row", () => {
  const previous = [row(1, 100), { ...row(2), removed: true }];
  const result = appendOffer(previous, { id: 2, name: "Вернулся" });
  assert.deepEqual(result.map((r) => r.share), [50, 50]);
  assert.equal(result[1].name, "Вернулся");
  assert.equal(result.length, 2);
});

test("cannot add nonexistent or invalid offers", () => {
  for (const id of [0, -1, NaN, 1.5]) {
    assert.throws(() => appendOffer([row(1, 100)], { id, name: "Test" }));
  }
  assert.throws(() => appendOffer([row(1, 100)], { id: 2, name: "  " }));
});

test("remove middle offer, restore it, return to exactly 100", () => {
  const initial = [row(1, 34), row(2, 33), row(3, 33)];
  const removed = switchRemoved(initial, 2);
  assert.deepEqual(removed.map((r) => r.share), [50, 0, 50]);
  assert.equal(removed[1].removed, true);
  const restored = switchRemoved(removed, 2);
  assert.deepEqual(restored.map((r) => r.share), [34, 33, 33]);
  assert.equal(restored[1].removed, false);
  assert.deepEqual(initial.map((r) => r.share), [34, 33, 33]);
});

test("cannot remove last active offer", () => {
  assert.throws(() => switchRemoved([row(1, 100)], 1), /хотя бы один активный/);
});

test("cannot remove an unknown offer", () => {
  assert.throws(() => switchRemoved([row(1, 100)], 42), /не найден/);
});

test("editing an unlocked share rebalances others without automatically pinning", () => {
  const initial = [row(1, 34), row(2, 33), row(3, 33)];
  const changed = changeShare(initial, 2, 40);
  assert.deepEqual(changed.map((offer) => offer.share), [30, 40, 30]);
  assert.deepEqual(changed.map((offer) => offer.locked), [false, false, false]);
  assert.equal(sharesValid(changed), true);
  assert.deepEqual(initial.map((offer) => offer.share), [34, 33, 33]);

  const editedAgain = changeShare(changed, 1, 50);
  assert.deepEqual(editedAgain.map((offer) => offer.share), [50, 25, 25]);
  assert.deepEqual(editedAgain.map((offer) => offer.locked), [false, false, false]);
  const added = appendOffer(editedAgain, { id: 4, name: "Четвёртый" });
  assert.deepEqual(added.map((offer) => offer.share), [25, 25, 25, 25]);
  assert.deepEqual(added.map((offer) => offer.locked), [false, false, false, false]);
});

test("manual share edits respect existing explicit pins without creating new ones", () => {
  const pinned = switchPin([row(1, 40), row(2, 30), row(3, 30)], 1);
  const changed = changeShare(pinned, 2, 35);
  assert.deepEqual(changed.map((offer) => offer.share), [40, 35, 25]);
  assert.deepEqual(changed.map((offer) => offer.locked), [true, false, false]);
  const modifiedPinned = changeShare(changed, 1, 50);
  assert.deepEqual(modifiedPinned.map((offer) => offer.share), [50, 25, 25]);
  assert.deepEqual(modifiedPinned.map((offer) => offer.locked), [true, false, false]);
});

test("share edit without spare flexible capacity is invalid, not silently pinned", () => {
  const pinned = switchPin([row(1, 40), row(2, 60)], 1);
  const edited = changeShare(pinned, 2, 50);
  assert.deepEqual(edited.map((offer) => offer.share), [40, 50]);
  assert.deepEqual(edited.map((offer) => offer.locked), [true, false]);
  assert.equal(sharesValid(edited), false);
  assert.throws(() => changeShare(pinned, 2, 70), /превышать 100%/);
});

test("pinned share stays fixed on adding a new offer", () => {
  const pinned = switchPin(changeShare([row(1, 100), row(2, 0)], 1, 40), 1);
  assert.deepEqual(pinned.map((r) => r.share), [40, 60]);
  assert.equal(pinned[0].locked, true);
  const next = appendOffer(pinned, { id: 3, name: "Третий" });
  assert.deepEqual(next.map((r) => r.share), [40, 30, 30]);
});

test("releasing pin restores equal allocation", () => {
  const pinned = switchPin(changeShare([row(1, 50), row(2, 50)], 1, 70), 1);
  assert.deepEqual(pinned.map((r) => r.share), [70, 30]);
  const released = switchPin(pinned, 1);
  assert.deepEqual(released.map((r) => r.share), [50, 50]);
});

test("changing share to 10 on the sole offer is intentionally not savable", () => {
  const changed = changeShare([row(18813, 100)], 18813, 10);
  assert.equal(changed[0].locked, false);
  assert.equal(changed[0].share, 10);
  assert.equal(sharesValid(changed), false);
  assert.throws(() => buildOffersPayload(changed), /100%/);
});

test("a pinned offer can be put back to 100 without needing others", () => {
  const changed = changeShare(switchPin([row(1, 100)], 1), 1, 10);
  const fixed = changeShare(changed, 1, 100);
  assert.equal(sharesValid(fixed), true);
  assert.deepEqual(buildOffersPayload(fixed), [{ offer_id: 1, share: 100, state: "active" }]);
});

test("invalid shares and pinned allocation over 100 are rejected", () => {
  for (const value of [-1, 101, 45.5, Infinity, NaN]) {
    assert.throws(() => changeShare([row(1, 100)], 1, value));
  }
  assert.throws(() => changeShare([
    { ...row(1, 70), locked: true }, row(2, 30), row(3, 0),
  ], 2, 40), /превышать 100/);
});

test("cannot edit removed or unknown offer", () => {
  assert.throws(() => changeShare([{ ...row(1, 0), removed: true }, row(2, 100)], 1, 30));
  assert.throws(() => changeShare([row(2, 100)], 3, 30));
});

test("removed and pinned offers do not pollute save payload", () => {
  const state = [row(1, 50), { ...row(2, 0), removed: true, locked: true }, { ...row(3, 50), locked: true }];
  assert.deepEqual(buildOffersPayload(state), [
    { offer_id: 1, share: 50, state: "active" },
    { offer_id: 3, share: 50, state: "active" },
  ]);
});

test("cannot save zero active offers", () => {
  assert.throws(() => buildOffersPayload([{ ...row(1), removed: true }]), /100%/);
});

test("cancel returns independent baseline rows and resets dirty state", () => {
  const before = [row(1, 100)];
  const modified = appendOffer(before, { id: 2, name: "Второй" });
  assert.notEqual(offersSignature(before), offersSignature(modified));
  const cancelled = resetEditor(before);
  assert.equal(offersSignature(before), offersSignature(cancelled));
  cancelled[0].share = 50;
  assert.equal(before[0].share, 100);
});

test("pin-only change has no effect on remote payload", () => {
  const before = [row(1, 100)];
  const pinned = switchPin(before, 1);
  assert.equal(offersSignature(before), offersSignature(pinned));
  assert.deepEqual(buildOffersPayload(pinned), buildOffersPayload(before));
});


test("percentage input can be cleared before replacement, but blank is not a saved share", () => {
  assert.equal(parseShareInput(""), null);
  assert.equal(parseShareInput("40"), 40);
  assert.equal(parseShareInput("0"), 0);
  assert.equal(parseShareInput("100"), 100);
  for (const text of ["-1", "101", "40.5", "1e2", "abc", "999999999999999999999"]) {
    assert.throws(() => parseShareInput(text), /целым числом/);
  }
});

test("after successful Push, removed offer stays gray and can be restored on next Push", () => {
  const fetched = [row(1, 34), row(2, 33), row(3, 33)];
  const removed = switchRemoved(fetched, 2);
  assert.deepEqual(buildOffersPayload(removed).map((r) => r.offer_id), [1, 3]);

  // Keitaro read-back only contains the two active offers; missing #2 is
  // intentionally retained in UI without being sent in the PUT payload.
  const verified = reconcileLoadedOffers(removed, [row(1, 50), row(3, 50)]);
  assert.deepEqual(verified.map((r) => [r.id, r.share, r.removed]), [
    [1, 50, false], [2, 0, true], [3, 50, false],
  ]);
  assert.equal(offersSignature(verified), offersSignature([row(1, 50), row(3, 50)]));
  assert.equal(sharesValid(verified), true);
  const restored = switchRemoved(verified, 2);
  assert.deepEqual(buildOffersPayload(restored).map((r) => [r.offer_id, r.share]), [
    [1, 34], [2, 33], [3, 33],
  ]);
  const restoredAndVerified = reconcileLoadedOffers(restored, [row(1, 34), row(2, 33), row(3, 33)]);
  assert.equal(restoredAndVerified.find((r) => r.id === 2)?.removed, false);
});

test("Fetch after external Keitaro deletion grays missing known offers", () => {
  const known = [row(1, 34), row(2, 33), row(3, 33)];
  const received = [row(3, 50), row(1, 50)];
  const merged = reconcileLoadedOffers(known, received);
  assert.deepEqual(merged.map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(merged.map((r) => r.removed), [false, true, false]);
  assert.equal(merged[1].share, 0);
  assert.deepEqual(buildOffersPayload(merged).map((r) => [r.offer_id, r.share]), [
    [1, 50], [3, 50],
  ]);
});

test("Fetch updates remote percentages and reactivates externally restored offer", () => {
  const previous = [row(1, 50), { ...row(2), removed: true }, row(3, 50)];
  const fetched = [row(1, 40), row(2, 30), row(3, 30)];
  const merged = reconcileLoadedOffers(previous, fetched);
  assert.deepEqual(merged.map((r) => r.share), [40, 30, 30]);
  assert.equal(merged[1].removed, false);
  assert.equal(sharesValid(merged), true);
});

test("Fetch retains names of removed offers no longer in the catalog", () => {
  const previous = [{ ...row(14, 100), name: "Исходное название", locked: true }];
  const fetched = reconcileLoadedOffers(previous, [
    { ...row(14, 100), name: "Оффер №14" },
  ]);
  assert.equal(fetched[0].name, "Исходное название");
  assert.equal(fetched[0].locked, false);
  const removed = reconcileLoadedOffers(fetched, []);
  assert.deepEqual(removed, [{ ...previous[0], removed: true, share: 0, locked: false }]);
});

test("Fetch never mutates inputs and does not duplicate known server IDs", () => {
  const known = [row(1, 100), row(2, 0), row(2, 0)];
  const received = [row(2, 30), row(3, 70)];
  const knownCopy = structuredClone(known);
  const receivedCopy = structuredClone(received);
  const merged = reconcileLoadedOffers(known, received);
  assert.deepEqual(merged.map((r) => r.id), [1, 2, 3]);
  assert.equal(merged[0].removed, true);
  assert.deepEqual(known, knownCopy);
  assert.deepEqual(received, receivedCopy);
});


test("pinned share survives Push read-back and subsequent edits", () => {
  const draft = switchPin(changeShare([row(1, 50), row(2, 50)], 1, 40), 1);
  const pinnedIds = new Set(draft.filter((item) => item.locked).map((item) => item.id));
  const remoteReadBack = [row(1, 40), row(2, 60)];
  const returned = restoreSessionPins(reconcileLoadedOffers(draft, remoteReadBack), pinnedIds);
  assert.equal(returned[0].locked, true);
  assert.equal(returned[0].share, 40);
  assert.equal(returned[1].locked, false);
  const withThird = appendOffer(returned, { id: 3, name: "Третий" });
  assert.deepEqual(withThird.map((item) => item.share), [40, 30, 30]);
  assert.deepEqual(buildOffersPayload(withThird).map((item) => item.share), [40, 30, 30]);
});

test("pin-only change survives Fetch while server shares remain authoritative", () => {
  const before = [row(1, 50), row(2, 50)];
  const pinned = switchPin(before, 1);
  assert.equal(offersSignature(before), offersSignature(pinned));
  const pinnedIds = new Set(pinned.filter((item) => item.locked).map((item) => item.id));
  const fetched = restoreSessionPins(reconcileLoadedOffers(before, [row(1, 70), row(2, 30)]), pinnedIds);
  assert.deepEqual(fetched.map((item) => item.share), [70, 30]);
  assert.deepEqual(fetched.map((item) => item.locked), [true, false]);
  assert.deepEqual(buildOffersPayload(fetched).map((item) => item.share), [70, 30]);
});

test("removed offers lose pins, other streams do not inherit them", () => {
  const received = [row(1, 50), { ...row(2), removed: true, share: 0 }];
  const previousPins = new Set([1, 2]);
  const synced = restoreSessionPins(received, previousPins);
  assert.deepEqual(synced.map((item) => item.locked), [true, false]);
  assert.deepEqual(restoreSessionPins(received, new Set()).map((item) => item.locked), [false, false]);
  assert.deepEqual(received.map((item) => item.locked), [false, false], "inputs stay immutable");
});


test("pin preferences persist across reloads and are isolated by stream", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  writeStoredPins(storage, 506, new Set([18003, 18001]));
  // Simulate a new Dashboard instance after F5: no in-memory state remains.
  const fetched = [row(18001, 40), row(18002, 60), row(18003, 0)];
  const restored = restoreSessionPins(fetched, readStoredPins(storage, 506));
  assert.deepEqual(restored.map((offer) => offer.locked), [true, false, true]);
  assert.deepEqual(restored.map((offer) => offer.share), [40, 60, 0]);
  assert.deepEqual([...readStoredPins(storage, 507)], []);
  writeStoredPins(storage, 506, new Set());
  assert.deepEqual([...readStoredPins(storage, 506)], []);
  assert.equal(data.size, 0);
});

test("stored pins are validated, removed offers are unpinned, and corrupt storage is harmless", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  storage.setItem("adrobot:offer-pins:v1:506", '[18001,-1,0,"18002",null,1.2,18001,18003]');
  assert.deepEqual([...readStoredPins(storage, 506)], [18001, 18003]);
  const fetched = [row(18001, 50), { ...row(18003), removed: true, share: 0 }];
  const restored = restoreSessionPins(fetched, readStoredPins(storage, 506));
  assert.deepEqual(restored.map((offer) => offer.locked), [true, false]);
  writeStoredPins(storage, 506, new Set(restored.filter((offer) => offer.locked).map((offer) => offer.id)));
  assert.deepEqual([...readStoredPins(storage, 506)], [18001]);
  storage.setItem("adrobot:offer-pins:v1:506", '{not-json');
  assert.deepEqual([...readStoredPins(storage, 506)], []);
  assert.deepEqual([...readStoredPins(storage, -1)], []);
});

test("disabled browser storage does not interrupt pinning", () => {
  const broken = {
    getItem: (): string | null => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); },
    removeItem: () => { throw new Error("storage disabled"); },
  };
  assert.deepEqual([...readStoredPins(broken, 506)], []);
  assert.doesNotThrow(() => writeStoredPins(broken, 506, new Set([18001])));
  assert.doesNotThrow(() => writeStoredPins(broken, 506, new Set()));
});
