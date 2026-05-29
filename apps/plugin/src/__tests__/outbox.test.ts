import { describe, expect, it } from "vitest";
import { createFileOpDraft, OutboxManager } from "../sync/outbox.js";

describe("OutboxManager", () => {
  it("assigns contiguous deviceSeq values, keeps inflight ops for retry, and acks idempotently", () => {
    const outbox = new OutboxManager("device-a", 5, []);
    const first = outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f1", type: "note", kind: "delete" }));
    const second = outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f2", type: "note", kind: "delete" }));
    expect([first.deviceSeq, second.deviceSeq]).toEqual([5, 6]);
    expect(outbox.nextDeviceSeq).toBe(7);
    expect(outbox.markInflight(first.opId)?.status).toBe("inflight");
    expect(outbox.retryable().map((x) => x.op.opId)).toEqual([first.opId, second.opId]);
    outbox.ack(first.opId, 10);
    outbox.ack(first.opId, 10);
    expect(outbox.entries.map((x) => x.op.opId)).toEqual([second.opId]);
  });
});
