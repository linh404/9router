const MAX_CODEX_REFRESH_FAILURES = 20;

export const CODEX_REFRESH_FAILURES_KEY = "codexRefreshFailures";
export { MAX_CODEX_REFRESH_FAILURES };

const failureWriteLocks = new Map();

function textValue(value, fallback = "Refresh failed") {
  const text = typeof value === "string" ? value : value == null ? "" : String(value);
  return (text.trim() || fallback).slice(0, 240);
}

export function buildCodexRefreshFailure({ error, code, status, source = "automatic", at = new Date().toISOString() } = {}) {
  return {
    at,
    source: source === "manual" ? "manual" : "automatic",
    message: textValue(error),
    ...(code ? { code: textValue(code, "unknown") } : {}),
    ...(Number.isFinite(Number(status)) ? { status: Number(status) } : {}),
  };
}

export function appendCodexRefreshFailure(providerSpecificData, failure) {
  const existing = Array.isArray(providerSpecificData?.[CODEX_REFRESH_FAILURES_KEY])
    ? providerSpecificData[CODEX_REFRESH_FAILURES_KEY]
    : [];

  return {
    ...(providerSpecificData || {}),
    [CODEX_REFRESH_FAILURES_KEY]: [...existing, failure].slice(-MAX_CODEX_REFRESH_FAILURES),
  };
}

/** Persist a redacted failure record without exposing OAuth credentials. */
export async function recordCodexRefreshFailure(connectionId, details = {}) {
  if (!connectionId) return null;

  const previous = failureWriteLocks.get(connectionId) || Promise.resolve();
  const write = previous.catch(() => {}).then(async () => {
    try {
      const { getProviderConnectionById, updateProviderConnection } = await import("../../lib/localDb.js");
      const connection = await getProviderConnectionById(connectionId);
      if (!connection || connection.provider !== "codex") return null;

      const failure = buildCodexRefreshFailure(details);
      const providerSpecificData = appendCodexRefreshFailure(
        connection.providerSpecificData,
        failure
      );

      return updateProviderConnection(connectionId, { providerSpecificData });
    } catch {
      // Refresh failures must never be hidden by a secondary logging failure.
      return null;
    }
  });

  failureWriteLocks.set(connectionId, write);
  try {
    return await write;
  } finally {
    if (failureWriteLocks.get(connectionId) === write) failureWriteLocks.delete(connectionId);
  }
}
