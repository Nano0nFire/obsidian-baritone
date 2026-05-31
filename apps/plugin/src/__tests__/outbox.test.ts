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

  it("rollbackLast removes the most recently enqueued op and frees its deviceSeq", () => {
    const outbox = new OutboxManager("device-a", 1, []);
    const a = outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f1", type: "note", kind: "delete" }));
    const b = outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f2", type: "note", kind: "delete" }));
    expect(outbox.nextDeviceSeq).toBe(3);
    expect(outbox.rollbackLast(b.opId)).toBe(true);
    expect(outbox.nextDeviceSeq).toBe(2);
    expect(outbox.entries.map((x) => x.op.opId)).toEqual([a.opId]);
    // The freed seq is reused by the next enqueue, keeping the stream contiguous.
    const c = outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f3", type: "note", kind: "delete" }));
    expect(c.deviceSeq).toBe(2);
  });

  it("rollbackLast refuses to roll back anything other than the highest deviceSeq", () => {
    const outbox = new OutboxManager("device-a", 1, []);
    const a = outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f1", type: "note", kind: "delete" }));
    outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f2", type: "note", kind: "delete" }));
    expect(outbox.rollbackLast(a.opId)).toBe(false);
    expect(outbox.nextDeviceSeq).toBe(3);
  });

  it("discardUnsent drops never-sent queued ops and rewinds nextDeviceSeq", () => {
    const outbox = new OutboxManager("device-a", 1, []);
    const a = outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f1", type: "note", kind: "delete" }));
    outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f2", type: "note", kind: "delete" }));
    outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f3", type: "note", kind: "delete" }));
    // Ack the first (server consumed seq 1); seqs 2 and 3 remain queued (never sent).
    outbox.ack(a.opId, 100);
    const result = outbox.discardUnsent();
    expect(result).toEqual({ discarded: 2, blockedByInflight: false });
    expect(outbox.entries).toHaveLength(0);
    expect(outbox.nextDeviceSeq).toBe(2);
  });

  it("discardUnsent is blocked while an op is inflight (server may have consumed its seq)", () => {
    const outbox = new OutboxManager("device-a", 1, []);
    outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f1", type: "note", kind: "delete" }));
    const b = outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f2", type: "note", kind: "delete" }));
    outbox.markInflight(b.opId);
    const result = outbox.discardUnsent();
    expect(result).toEqual({ discarded: 0, blockedByInflight: true });
    expect(outbox.entries).toHaveLength(2);
    expect(outbox.nextDeviceSeq).toBe(3);
  });

  it("removes an unconsumed op and reindexes later queued entries to avoid seq gaps", () => {
    const outbox = new OutboxManager("device-a", 1, []);
    const first = outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f1", type: "note", kind: "delete" }));
    const second = outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f2", type: "note", kind: "delete" }));
    const third = outbox.enqueue(createFileOpDraft({ vaultId: "v", fileId: "f3", type: "note", kind: "delete" }));

    expect(outbox.removeAndReindex(first.opId)).toBe(true);
    expect(outbox.entries.map((entry) => entry.op.deviceSeq)).toEqual([1, 2]);
    expect(outbox.entries.map((entry) => entry.op.opId)).toEqual([second.opId, third.opId]);
    expect(outbox.nextDeviceSeq).toBe(3);
  });
});
