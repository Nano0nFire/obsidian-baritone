import { describe, expect, it, vi } from "vitest";
import { SyncLogStore } from "../logs/log-store.js";

describe("SyncLogStore", () => {
  it("keeps only the most recent entries up to the configured limit", () => {
    const store = new SyncLogStore(3);

    store.append({ level: "info", source: "plugin", message: "one" });
    store.append({ level: "info", source: "plugin", message: "two" });
    store.append({ level: "warn", source: "engine", message: "three" });
    store.append({ level: "error", source: "transport", message: "four" });

    expect(store.all().map((entry) => entry.message)).toEqual(["two", "three", "four"]);
    expect(store.all().map((entry) => entry.id)).toEqual([2, 3, 4]);
  });

  it("notifies subscribers on append and clear", () => {
    const store = new SyncLogStore();
    const listener = vi.fn();
    const off = store.onChange(listener);

    store.append({ level: "info", source: "plugin", message: "hello" });
    store.clear();

    off();
    store.append({ level: "info", source: "plugin", message: "ignored" });

    expect(listener).toHaveBeenCalledTimes(2);
  });
});
