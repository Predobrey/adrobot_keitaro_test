import { test } from "node:test";
import assert from "node:assert/strict";
import { distribute, offersSignature, sharesValid, type OfferRow } from "./distribution.ts";

const make = (id: number, share = 0): OfferRow => ({ id, name: `Offer #${id}`, share, locked: false, removed: false });

test("three offers split to 34/33/33, with total exactly 100", () => {
  const result = distribute([make(1), make(2), make(3)]);
  assert.deepEqual(result.map((o) => o.share), [34, 33, 33]);
  assert.equal(sharesValid(result), true);
});

test("adding one more unlocked offer yields 25% each", () => {
  const rows = distribute([make(1), make(2), make(3), make(4)]);
  assert.deepEqual(rows.map((r) => r.share), [25, 25, 25, 25]);
});

test("locked share stays fixed and remaining amount is distributed", () => {
  const rows = distribute([{ ...make(1, 40), locked: true }, make(2), make(3)]);
  assert.deepEqual(rows.map((r) => r.share), [40, 30, 30]);
});

test("removed offers are zeroed, never sent and do not receive shares", () => {
  const rows = distribute([make(1), { ...make(2, 60), removed: true }, make(3)]);
  assert.deepEqual(rows.map((r) => r.share), [50, 0, 50]);
  assert.equal(sharesValid(rows), true);
});

test("no active offers or incomplete pinned allocation cannot save", () => {
  assert.equal(sharesValid([{ ...make(1), removed: true }]), false);
  assert.equal(sharesValid([{ ...make(1, 40), locked: true }]), false);
});

test("only effective changes mark the editor dirty", () => {
  const before = [make(1, 100)];
  assert.equal(offersSignature(before), offersSignature([{ ...make(1, 100), locked: true }]));
  assert.notEqual(offersSignature(before), offersSignature([make(1, 50), make(2, 50)]));
});
