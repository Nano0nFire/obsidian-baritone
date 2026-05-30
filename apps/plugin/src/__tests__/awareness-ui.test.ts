import { describe, expect, it } from "vitest";
import { colorFromIdentity, makeLocalAwarenessState, reduceAwarenessStates } from "../sync/awareness-ui.js";

describe("awareness identity", () => {
  it("derives a stable user name and deterministic color from settings", () => {
    const first = makeLocalAwarenessState({ username: "  Ada Lovelace  ", deviceId: "device-abc123" });
    const second = makeLocalAwarenessState({ username: "Ada Lovelace", deviceId: "device-abc123" });

    expect(first.user.name).toBe("Ada Lovelace");
    expect(second.user).toEqual(first.user);
    expect(first.user.color).toMatch(/^#[0-9a-f]{6}$/u);
    expect(first.user.colorLight).toMatch(/^#[0-9a-f]{8}$/u);
  });

  it("falls back to a readable stable device name when username is unavailable", () => {
    const state = makeLocalAwarenessState({ username: "", deviceId: "9f7d6c5b4a3" });

    expect(state.user.name).toBe("Device 9f7d6c");
    expect(state.user.id).toBe("9f7d6c5b4a3");
  });

  it("maps the same identity to the same color and different identities to distinct colors", () => {
    expect(colorFromIdentity("alice@example")).toEqual(colorFromIdentity("alice@example"));
    expect(colorFromIdentity("alice@example").color).not.toBe(colorFromIdentity("bob@example").color);
  });
});

describe("reduceAwarenessStates", () => {
  it("returns local participant first, then remote participants sorted by name", () => {
    const states = new Map<number, Record<string, unknown>>([
      [42, { user: { name: "Zoe", color: "#111111", colorLight: "#11111133", id: "zoe" }, cursor: { anchor: {}, head: {} } }],
      [7, { user: { name: "Local", color: "#222222", colorLight: "#22222233", id: "local" } }],
      [13, { user: { name: "Amy", color: "#333333", colorLight: "#33333333", id: "amy" }, cursor: { anchor: {}, head: {} } }],
    ]);

    expect(reduceAwarenessStates(states, 7)).toEqual([
      { clientId: 7, name: "Local", color: "#222222", colorLight: "#22222233", isLocal: true, hasCursor: false },
      { clientId: 13, name: "Amy", color: "#333333", colorLight: "#33333333", isLocal: false, hasCursor: true },
      { clientId: 42, name: "Zoe", color: "#111111", colorLight: "#11111133", isLocal: false, hasCursor: true },
    ]);
  });

  it("normalizes malformed remote user state without throwing", () => {
    const participants = reduceAwarenessStates(new Map([[3, { user: { name: "", color: "hotpink" } }]]), 1);

    expect(participants).toHaveLength(1);
    expect(participants[0]?.name).toBe("Guest 3");
    expect(participants[0]?.color).toMatch(/^#[0-9a-f]{6}$/u);
  });
});
