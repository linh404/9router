export const CODEX_EXPIRY_THRESHOLDS = [
  { days: 1, ms: 24 * 60 * 60 * 1000 },
  { days: 2, ms: 2 * 24 * 60 * 60 * 1000 },
  { days: 3, ms: 3 * 24 * 60 * 60 * 1000 },
];

function parseExpiry(expiresAt) {
  if (!expiresAt) return null;
  const timestamp = new Date(expiresAt).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function getCodexExpiryWarning(connection, nowMs = Date.now()) {
  if (!connection || connection.provider !== "codex") return null;
  if (String(connection.authType || "").toLowerCase() !== "oauth") return null;

  const expiresAtMs = parseExpiry(connection.expiresAt);
  if (expiresAtMs === null) return null;

  const remainingMs = expiresAtMs - nowMs;
  if (remainingMs <= 0 || remainingMs > CODEX_EXPIRY_THRESHOLDS.at(-1).ms) return null;

  const threshold = CODEX_EXPIRY_THRESHOLDS.find((item) => remainingMs <= item.ms);
  if (!threshold) return null;

  return {
    days: threshold.days,
    expiresAt: new Date(expiresAtMs).toISOString(),
    remainingMs,
  };
}

export function getCodexExpiryNotificationKey(connection, warning) {
  if (!connection?.id || !warning?.days || !warning?.expiresAt) return null;
  return `codex-token-expiry:${connection.id}:${warning.expiresAt}:${warning.days}`;
}

export function wasCodexExpiryNotificationSent(connection, warning) {
  const key = getCodexExpiryNotificationKey(connection, warning);
  if (!key || typeof window === "undefined") return false;

  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function markCodexExpiryNotificationSent(connection, warning) {
  const key = getCodexExpiryNotificationKey(connection, warning);
  if (!key || typeof window === "undefined") return;

  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage may be unavailable in private browsing or test environments.
  }
}
