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

test("one unlocked offer always occupies 100%", () => {
  assert.deepEqual(distribute([make(7, 1)]).map((r) => r.share), [100]);
});

test("five offers share 100 without rounding drift", () => {
  const shares = distribute(Array.from({ length: 5 }, (_, i) => make(i + 1)));
  assert.deepEqual(shares.map((row) => row.share), [20, 20, 20, 20, 20]);
});

test("mixed pinned and flexible offers divide only the remainder", () => {
  const shares = distribute([{ ...make(1, 35), locked: true }, make(2), make(3), make(4)]);
  assert.deepEqual(shares.map((row) => row.share), [35, 22, 22, 21]);
});

test("two pinned offers leave remainder for free rows", () => {
  const shares = distribute([{ ...make(1, 40), locked: true }, { ...make(2, 30), locked: true }, make(3), make(4)]);
  assert.deepEqual(shares.map((row) => row.share), [40, 30, 15, 15]);
});

test("a single pinned 10% offer is incomplete and cannot save", () => {
  const shares = distribute([{ ...make(1, 10), locked: true }]);
  assert.equal(shares[0].share, 10);
  assert.equal(sharesValid(shares), false);
});

test("all pinned shares totalling 100 are valid", () => {
  const shares = distribute([{ ...make(1, 65), locked: true }, { ...make(2, 35), locked: true }]);
  assert.equal(sharesValid(shares), true);
});

test("invalid pinned total is never silently normalized", () => {
  const shares = distribute([{ ...make(1, 80), locked: true }, { ...make(2, 30), locked: true }]);
  assert.deepEqual(shares.map((row) => row.share), [80, 30]);
  assert.equal(sharesValid(shares), false);
});

test("fractional, negative, NaN and greater-than-100 shares are invalid", () => {
  for (const share of [-1, 25.5, 101, NaN, Infinity]) {
    assert.equal(sharesValid([make(1, share)]), false);
  }
});

test("duplicate active offer IDs are invalid", () => {
  assert.equal(sharesValid([make(1, 50), make(1, 50)]), false);
});

test("removed offer never contributes to signature or validation", () => {
  const before = [make(1, 100)];
  const after = [make(1, 100), { ...make(2, 0), removed: true }];
  assert.equal(offersSignature(before), offersSignature(after));
  assert.equal(sharesValid(after), true);
});

test("share signature detects changed traffic allocation and order", () => {
  const first = [make(1, 60), make(2, 40)];
  assert.notEqual(offersSignature(first), offersSignature([make(1, 40), make(2, 60)]));
  assert.notEqual(offersSignature(first), offersSignature([make(2, 40), make(1, 60)]));
});
