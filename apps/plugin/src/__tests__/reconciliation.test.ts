import { describe, expect, it } from "vitest";
import { planReconciliation } from "../watcher/reconciliation.js";

describe("planReconciliation", () => {
  it("detects missed renames by matching content hashes before create/delete", () => {
    const plan = planReconciliation({
      indexed: [
        { fileId: "f1", path: "old.md", contentHash: "sha256:a", mtime: 1, size: 1 },
        { fileId: "f2", path: "deleted.md", contentHash: "sha256:b", mtime: 1, size: 1 },
      ],
      disk: [
        { path: "new.md", contentHash: "sha256:a", mtime: 2, size: 1 },
        { path: "created.md", contentHash: "sha256:c", mtime: 2, size: 1 },
      ],
    });
    expect(plan.renames).toEqual([{ fileId: "f1", oldPath: "old.md", newPath: "new.md", contentHash: "sha256:a" }]);
    expect(plan.creates.map((x) => x.path)).toEqual(["created.md"]);
    expect(plan.deletes.map((x) => x.path)).toEqual(["deleted.md"]);
  });
});
