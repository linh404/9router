// Ensure proxyFetch is loaded before usage checks run server-side.
import "open-sse/index.js";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/lib/oauth/refreshCredentials";

const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];

function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const message = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Convert a stored Codex OAuth connection to the native Codex account shape.
 *
 * The dashboard Import JSON flow uses records with this exact structure.  The
 * export route writes these records as one JSON array so the same file can be
 * selected by Import JSON or Auto Login:
 *
 *   { "2fa", "OPENAI_API_KEY", "email", "last_refresh", "password",
 *     "tokens": { "access_token", "account_id", "id_token", "refresh_token" } }
 *
 * Internal 9router settings and refresh-failure logs are deliberately not
 * exported.  The optional 2FA/password fields are preserved when they came
 * from a native Codex import; connections created through the OAuth flow use
 * null because 9router does not have those values.
 */
export function toCodexImportAccount(connection, credentials = connection) {
  const providerSpecificData = connection?.providerSpecificData || {};
  const accessToken = credentials?.accessToken || connection?.accessToken;
  const refreshToken = credentials?.refreshToken || connection?.refreshToken;
  const idToken = credentials?.idToken || connection?.idToken;
  const lastRefreshAt = credentials?.lastRefreshAt || connection?.lastRefreshAt;
  const accountId =
    providerSpecificData.chatgptAccountId ||
    providerSpecificData.accountId ||
    connection?.accountId ||
    "";
  const sourceValue = (key, ...aliases) => {
    for (const source of [connection, providerSpecificData]) {
      for (const field of [key, ...aliases]) {
        if (source && Object.prototype.hasOwnProperty.call(source, field)) {
          return source[field];
        }
      }
    }
    return null;
  };

  return {
    "2fa": sourceValue("2fa", "twoFactor", "two_factor"),
    OPENAI_API_KEY: sourceValue("OPENAI_API_KEY", "openaiApiKey", "openai_api_key"),
    email: connection?.email || "",
    last_refresh: lastRefreshAt || connection?.updatedAt || null,
    password: sourceValue("password", "codexPassword"),
    tokens: {
      access_token: accessToken || "",
      account_id: accountId,
      id_token: idToken || "",
      refresh_token: refreshToken || "",
    },
  };
}

export function isExportableCodexConnection(connection) {
  return Boolean(
    connection?.authType === "oauth" &&
    connection?.accessToken &&
    connection?.refreshToken
  );
}

/**
 * Fetch the current Codex quota snapshot and return the primary session reset
 * together with the possibly refreshed connection used for that check.
 * Usage failures are handled by the export route so one unavailable account
 * does not prevent the remaining accounts from being exported.
 */
export async function fetchCodexPrimaryResetAt(connection) {
  const proxyConfig = await resolveConnectionProxyConfig(connection?.providerSpecificData || {});
  const proxyOptions = {
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
    connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
    connectionNoProxy: proxyConfig.connectionNoProxy || "",
    vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
    strictProxy: false,
  };
  let refreshed = await refreshAndUpdateCredentials(connection, false, proxyOptions);
  let usage = await getUsageForProvider(refreshed.connection, proxyOptions, { force: true });
  if (isAuthExpiredMessage(usage) && refreshed.connection.refreshToken) {
    try {
      refreshed = await refreshAndUpdateCredentials(refreshed.connection, true, proxyOptions);
      usage = await getUsageForProvider(refreshed.connection, proxyOptions, { force: true });
    } catch (error) {
      console.warn(`[Codex export] Force refresh failed: ${error.message}`);
    }
  }
  const resetAt = usage?.quotas?.session?.resetAt
    || usage?.quotas?.primary_session?.resetAt
    || usage?.quotas?.primary?.resetAt
    || null;
  const timestamp = resetAt ? Date.parse(resetAt) : Number.NaN;
  if (!Number.isFinite(timestamp)) return { connection: refreshed.connection, resetAt: null, timestamp: Number.NaN };
  return { connection: refreshed.connection, resetAt, timestamp };
}

/** Sort by primary session reset time; accounts without a valid reset go last. */
export function sortCodexExportRecords(records) {
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const leftTime = left.record.reset?.timestamp;
      const rightTime = right.record.reset?.timestamp;
      const leftMissing = !Number.isFinite(leftTime);
      const rightMissing = !Number.isFinite(rightTime);
      if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing) return left.index - right.index;
        return leftMissing ? 1 : -1;
      }
      return leftTime - rightTime || left.index - right.index;
    })
    .map(({ record }) => record);
}
