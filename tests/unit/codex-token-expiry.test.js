import { describe, expect, it } from "vitest";
import {
  getCodexExpiryNotificationKey,
  getCodexExpiryWarning,
} from "../../src/shared/utils/codexTokenExpiry.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-06T00:00:00.000Z");

describe("Codex token expiry warnings", () => {
  it("returns the nearest warning threshold within three days", () => {
    const warning = getCodexExpiryWarning({
      provider: "codex",
      authType: "oauth",
      id: "conn-1",
      expiresAt: new Date(NOW + 2 * DAY_MS - 1).toISOString(),
    }, NOW);

    expect(warning.days).toBe(2);
  });

  it("does not warn for non-Codex, non-OAuth, distant, or expired tokens", () => {
    expect(getCodexExpiryWarning({ provider: "claude", authType: "oauth", expiresAt: new Date(NOW + DAY_MS).toISOString() }, NOW)).toBeNull();
    expect(getCodexExpiryWarning({ provider: "codex", authType: "apikey", expiresAt: new Date(NOW + DAY_MS).toISOString() }, NOW)).toBeNull();
    expect(getCodexExpiryWarning({ provider: "codex", authType: "oauth", expiresAt: new Date(NOW + 4 * DAY_MS).toISOString() }, NOW)).toBeNull();
    expect(getCodexExpiryWarning({ provider: "codex", authType: "oauth", expiresAt: new Date(NOW - 1).toISOString() }, NOW)).toBeNull();
  });

  it("changes the dedupe key when the expiry or threshold changes", () => {
    const connection = { id: "conn-1" };
    const first = { days: 3, expiresAt: "2026-09-09T00:00:00.000Z" };
    const second = { days: 2, expiresAt: "2026-09-09T00:00:00.000Z" };

    expect(getCodexExpiryNotificationKey(connection, first)).not.toBe(
      getCodexExpiryNotificationKey(connection, second)
    );
  });
});
