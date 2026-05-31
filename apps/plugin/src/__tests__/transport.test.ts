import { describe, expect, it } from "vitest";
import { parseServerMessage } from "../sync/transport.js";

describe("parseServerMessage", () => {
  it("rejects malformed reject messages", () => {
    expect(() => parseServerMessage(JSON.stringify({ t: "reject" }))).toThrow("Invalid reject message");
  });

  it("accepts well-formed reject messages", () => {
    expect(parseServerMessage(JSON.stringify({ t: "reject", code: "STALE", message: "blocked" }))).toMatchObject({
      t: "reject",
      code: "STALE",
      message: "blocked",
    });
  });
});
