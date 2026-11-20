import { test } from "node:test";
import assert from "node:assert/strict";
import { appendOffer, buildOffersPayload, changeShare, resetEditor, switchPin, switchRemoved } from "./editor.ts";
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

test("pinned share stays fixed on adding a new offer", () => {
  const pinned = changeShare([row(1, 100), row(2, 0)], 1, 40);
  assert.deepEqual(pinned.map((r) => r.share), [40, 60]);
  assert.equal(pinned[0].locked, true);
  const next = appendOffer(pinned, { id: 3, name: "Третий" });
  assert.deepEqual(next.map((r) => r.share), [40, 30, 30]);
});

test("releasing pin restores equal allocation", () => {
  const pinned = changeShare([row(1, 50), row(2, 50)], 1, 70);
  assert.deepEqual(pinned.map((r) => r.share), [70, 30]);
  const released = switchPin(pinned, 1);
  assert.deepEqual(released.map((r) => r.share), [50, 50]);
});

test("changing share to 10 on the sole offer is intentionally not savable", () => {
  const changed = changeShare([row(18813, 100)], 18813, 10);
  assert.equal(changed[0].locked, true);
  assert.equal(changed[0].share, 10);
  assert.equal(sharesValid(changed), false);
  assert.throws(() => buildOffersPayload(changed), /100%/);
});

test("a pinned offer can be put back to 100 without needing others", () => {
  const changed = changeShare([row(1, 100)], 1, 10);
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
