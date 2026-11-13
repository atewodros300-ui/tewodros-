import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "./store.mjs";

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "govflow-test-"));
  const file = path.join(directory, "state.json");
  let now = new Date("2026-11-12T12:00:00.000Z");
  const store = createStore(file, () => new Date(now));
  return { store, file, setNow: (value) => { now = new Date(value); }, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("issues a ticket and persists its queue status", () => {
  const fixture = temporaryStore();
  try {
    const visitor = fixture.store.createVisitor({ branchId: "central", serviceCategory: "Civil registration" });
    assert.match(visitor.ticket, /^CT-\d{8}-001$/);
    assert.equal(visitor.status, "WAITING");
    fixture.store.updateVisitor(visitor.id, "call");
    fixture.setNow("2026-11-12T12:04:00.000Z");
    const served = fixture.store.updateVisitor(visitor.id, "serve");
    assert.equal(served.status, "SERVED");
    assert.equal(served.serviceSeconds, 240);
    assert.equal(JSON.parse(fs.readFileSync(fixture.file, "utf8")).visitors[0].status, "SERVED");
  } finally {
    fixture.cleanup();
  }
});

test("rejects invalid queue transitions and unknown branches", () => {
  const fixture = temporaryStore();
  try {
    assert.throws(() => fixture.store.createVisitor({ branchId: "missing", serviceCategory: "Civil registration" }), /Branch not found/);
    const visitor = fixture.store.createVisitor({ branchId: "central", serviceCategory: "Civil registration" });
    assert.throws(() => fixture.store.updateVisitor(visitor.id, "serve"), /not available/);
    assert.throws(() => fixture.store.createVisitor({ branchId: "central", serviceCategory: "Unknown" }), /valid service category/);
  } finally {
    fixture.cleanup();
  }
});

test("validates branch settings and prevents duplicate ticket prefixes", () => {
  const fixture = temporaryStore();
  try {
    const branch = fixture.store.createBranch({ name: "North Office", city: "Addis Ababa", region: "Central", prefix: "NO" });
    assert.equal(branch.staffCount, 1);
    assert.equal(fixture.store.updateBranch(branch.id, { staffCount: 6 }).staffCount, 6);
    assert.throws(() => fixture.store.updateBranch(branch.id, { staffCount: 0 }), /between 1 and 500/);
    assert.throws(() => fixture.store.createBranch({ name: "Duplicate", city: "Addis Ababa", prefix: "NO" }), /already in use/);
  } finally {
    fixture.cleanup();
  }
});
