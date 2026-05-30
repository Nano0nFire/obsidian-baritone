export interface AwarenessIdentitySettings {
  readonly username: string;
  readonly deviceId: string;
}

export interface AwarenessUser {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly colorLight: string;
}

export interface LocalAwarenessState {
  readonly user: AwarenessUser;
}

export interface PresenceParticipant {
  readonly clientId: number;
  readonly name: string;
  readonly color: string;
  readonly colorLight: string;
  readonly isLocal: boolean;
  readonly hasCursor: boolean;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
const HEX_COLOR_WITH_ALPHA = /^#[0-9a-f]{8}$/iu;

function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function hueToRgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function hslToHex(hue: number, saturationPercent: number, lightnessPercent: number): string {
  const h = hue / 360;
  const s = saturationPercent / 100;
  const l = lightnessPercent / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channels = [hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3)];
  return `#${channels.map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
}

function normalizeName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim().replace(/\s+/gu, " ");
  return trimmed ? trimmed.slice(0, 64) : null;
}

function normalizeId(id: unknown, fallback: string): string {
  if (typeof id !== "string") return fallback;
  const trimmed = id.trim();
  return trimmed ? trimmed.slice(0, 128) : fallback;
}

function deviceFallbackName(deviceId: string): string {
  const id = deviceId.trim();
  return id ? `Device ${id.slice(0, 6)}` : "Anonymous";
}

export function colorFromIdentity(identity: string): Pick<AwarenessUser, "color" | "colorLight"> {
  const hash = stableHash(identity || "anonymous");
  const hue = hash % 360;
  const color = hslToHex(hue, 68, 46);
  return { color, colorLight: `${color}33` };
}

export function makeLocalAwarenessState(settings: AwarenessIdentitySettings): LocalAwarenessState {
  const id = settings.deviceId.trim() || "anonymous-device";
  const name = normalizeName(settings.username) ?? deviceFallbackName(settings.deviceId);
  return { user: { id, name, ...colorFromIdentity(`${name}:${id}`) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function hasCursor(state: Record<string, unknown>): boolean {
  const cursor = state.cursor;
  if (!isRecord(cursor)) return false;
  return cursor.anchor != null && cursor.head != null;
}

function userFromState(state: Record<string, unknown>, clientId: number): AwarenessUser {
  const user = isRecord(state.user) ? state.user : {};
  const fallbackId = `client-${clientId}`;
  const id = normalizeId(user.id, fallbackId);
  const name = normalizeName(user.name) ?? `Guest ${clientId}`;
  const fallbackColors = colorFromIdentity(id);
  const color = typeof user.color === "string" && HEX_COLOR.test(user.color) ? user.color.toLowerCase() : fallbackColors.color;
  const colorLight = typeof user.colorLight === "string" && HEX_COLOR_WITH_ALPHA.test(user.colorLight)
    ? user.colorLight.toLowerCase()
    : `${color}33`;
  return { id, name, color, colorLight };
}

export function reduceAwarenessStates(states: ReadonlyMap<number, Record<string, unknown>>, localClientId: number): PresenceParticipant[] {
  return [...states.entries()]
    .filter(([, state]) => isRecord(state))
    .map(([clientId, state]) => {
      const user = userFromState(state, clientId);
      return { clientId, name: user.name, color: user.color, colorLight: user.colorLight, isLocal: clientId === localClientId, hasCursor: hasCursor(state) };
    })
    .sort((a, b) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.clientId - b.clientId;
    });
}
