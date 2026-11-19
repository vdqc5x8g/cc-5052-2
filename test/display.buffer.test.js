import test from "node:test";
import assert from "node:assert/strict";
import {
  DisplayBuffer,
  DisplayClock,
  interpolateHeading,
  validateStatePacket,
  HEADING_GUARD,
} from "../public/display.js";

function packet(seq, t, overrides = []) {
  const base = [
    { id: "v1", x: seq * 10, y: 6, z: 0, heading: 0, bank: 0, speed: 50 },
    { id: "v2", x: 0, y: 6, z: seq * 10, heading: 0, bank: 0, speed: 50 },
  ];
  for (const o of overrides) Object.assign(base[0], o);
  return { type: "state", v: 1, epoch: 1, seq, t, vehicles: base };
}

test("packet validation rejects non-finite state", () => {
  const bad = packet(1, 1000);
  bad.vehicles[0].x = NaN;
  assert.equal(validateStatePacket(bad, false), false);
  assert.equal(validateStatePacket(packet(1, 1000), false), true);
  assert.equal(validateStatePacket(packet(1, 1000), true), true);
  const noEpoch = packet(1, 1000);
  delete noEpoch.epoch;
  assert.equal(validateStatePacket(noEpoch, true), false);
});

test("buffer sorts by authority timestamp, not arrival order", () => {
  const buf = new DisplayBuffer();
  assert.equal(buf.ingest(packet(1, 1000)).ok, true);
  assert.equal(buf.ingest(packet(3, 1200)).ok, true);
  const late = buf.ingest(packet(2, 1100));
  assert.equal(late.ok, true);
  assert.equal(late.insertedAt, 1);
  assert.deepEqual(buf.samples.map((s) => s.t), [1000, 1100, 1200]);
  assert.equal(buf.stats.outOfOrder, 1, "seq 2 arriving after 3 is out of order");
});
