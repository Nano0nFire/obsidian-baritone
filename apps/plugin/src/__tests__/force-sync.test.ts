import { describe, expect, it } from "vitest";
import { planForcePush, planForcePullStrays, type LocalFileSnapshot, type RemoteFileSnapshot } from "../sync/force-sync.js";

function local(path: string, hash: string, extra: Partial<LocalFileSnapshot> = {}): LocalFileSnapshot {
  return { path, hash, type: "note", ...extra };
}

function remote(fileId: string, path: string, contentHash: string | null, contentVV: Record<string, number>, extra: Partial<RemoteFileSnapshot> = {}): RemoteFileSnapshot {
  return { fileId, path, contentHash, contentVV, type: "note", ...extra };
}

let counter = 0;
const newFileId = () => `new-${(counter += 1)}`;

describe("planForcePush", () => {
  it("creates new files absent from remote with an empty dominate vector", () => {
    counter = 0;
    const plan = planForcePush([local("a.md", "sha256:aaa")], [], newFileId);
    expect(plan.actions).toEqual([
      { kind: "content", mode: "create", fileId: "new-1", path: "a.md", type: "note", dominateVV: {} },
    ]);
  });

  it("reuses the local fileId for creates when it does not collide with a remote fileId", () => {
    counter = 0;
    const plan = planForcePush([local("a.md", "sha256:aaa", { fileId: "local-1" })], [], newFileId);
    expect(plan.actions[0]).toMatchObject({ kind: "content", mode: "create", fileId: "local-1" });
  });

  it("mints a fresh fileId when the local fileId collides with a remote file at a different path", () => {
    counter = 0;
    const plan = planForcePush(
      [local("a.md", "sha256:aaa", { fileId: "shared" })],
      [remote("shared", "b.md", "sha256:bbb", { remote: 2 })],
      newFileId,
    );
    // a.md is a create (no remote at that path) but fileId "shared" already exists remotely at b.md
    const create = plan.actions.find((x) => x.kind === "content");
    expect(create).toMatchObject({ kind: "content", mode: "create", fileId: "new-1", path: "a.md" });
  });

  it("skips content for files whose remote hash already equals local, but records fileId adoption", () => {
    counter = 0;
    const plan = planForcePush(
      [local("a.md", "sha256:same", { fileId: "local-a" })],
      [remote("remote-a", "a.md", "sha256:same", { remote: 3 })],
      newFileId,
    );
    expect(plan.actions.filter((x) => x.kind === "content")).toHaveLength(0);
    expect(plan.adoptions).toContainEqual({ path: "a.md", oldFileId: "local-a", newFileId: "remote-a" });
  });

  it("updates with a dominate vector equal to the remote content vector when hashes differ", () => {
    counter = 0;
    const plan = planForcePush(
      [local("a.md", "sha256:local", { fileId: "remote-a" })],
      [remote("remote-a", "a.md", "sha256:remote", { remote: 5, other: 2 })],
      newFileId,
    );
    expect(plan.actions).toContainEqual({
      kind: "content",
      mode: "update",
      fileId: "remote-a",
      path: "a.md",
      type: "note",
      dominateVV: { remote: 5, other: 2 },
    });
  });

  it("emits deletes for remote files that have no local counterpart", () => {
    counter = 0;
    const plan = planForcePush(
      [],
      [remote("remote-x", "gone.md", "sha256:x", { remote: 1 }, { type: "attachment" })],
      newFileId,
    );
    expect(plan.actions).toContainEqual({ kind: "delete", fileId: "remote-x", path: "gone.md", type: "attachment" });
  });

  it("matches paths case-insensitively (no spurious create+delete for case-only differences)", () => {
    counter = 0;
    const plan = planForcePush(
      [local("Notes/A.md", "sha256:same", { fileId: "rid" })],
      [remote("rid", "notes/a.md", "sha256:same", { remote: 1 })],
      newFileId,
    );
    expect(plan.actions).toHaveLength(0);
  });
});

describe("planForcePullStrays", () => {
  it("returns local paths absent from the remote live manifest", () => {
    const strays = planForcePullStrays(
      ["keep.md", "stray.md", "Sub/Keep.md"],
      [remote("r1", "keep.md", "sha256:1", {}), remote("r2", "sub/keep.md", "sha256:2", {})],
    );
    expect(strays).toEqual(["stray.md"]);
  });

  it("returns an empty array when every local file exists remotely", () => {
    const strays = planForcePullStrays(["a.md"], [remote("r1", "a.md", "sha256:1", {})]);
    expect(strays).toEqual([]);
  });
});
