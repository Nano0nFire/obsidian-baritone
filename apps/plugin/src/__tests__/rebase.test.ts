import { describe, expect, it } from "vitest";
import { rebaseContentDraft } from "../sync/rebase.js";

describe("rebaseContentDraft", () => {
  it("rebases stale local edits onto dominating remote VVs and reports true conflicts", () => {
    expect(rebaseContentDraft({ a: 1 }, { a: 1, b: 2 }, "a")).toEqual({ ok: true, base: { a: 1, b: 2 }, next: { a: 2, b: 2 } });
    expect(rebaseContentDraft({ a: 2 }, { a: 1, b: 1 }, "a")).toEqual({ ok: false, reason: "concurrent" });
  });
});
