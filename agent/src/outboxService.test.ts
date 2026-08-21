import { describe, expect, it } from "vitest";
import { openAgentDb } from "./db.js";
import { countPending, enqueueEvent, getPendingEvents, markSent } from "./outboxService.js";

describe("outboxService", () => {
  it("enqueues an event as pending and lists it", () => {
    const db = openAgentDb(":memory:");
    const { clientEventId } = enqueueEvent(db, "transaction_completed", { amount: 500 });

    const pending = getPendingEvents(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.client_event_id).toBe(clientEventId);
    expect(pending[0]!.sent_at).toBeNull();
    expect(JSON.parse(pending[0]!.payload!)).toEqual({ amount: 500 });
    expect(countPending(db)).toBe(1);
  });

  it("marking sent removes an event from the pending list", () => {
    const db = openAgentDb(":memory:");
    const a = enqueueEvent(db, "transaction_completed", { amount: 1 });
    enqueueEvent(db, "transaction_completed", { amount: 2 });

    markSent(db, [a.clientEventId]);

    const pending = getPendingEvents(db);
    expect(pending).toHaveLength(1);
    expect(countPending(db)).toBe(1);
  });

  it("respects the limit parameter and returns oldest first", () => {
    const db = openAgentDb(":memory:");
    const first = enqueueEvent(db, "e", 1);
    enqueueEvent(db, "e", 2);
    enqueueEvent(db, "e", 3);

    const pending = getPendingEvents(db, 1);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.client_event_id).toBe(first.clientEventId);
  });
});
