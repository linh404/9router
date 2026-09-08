/**
 * Convert a stored Codex OAuth connection to the native Codex account shape.
 *
 * The source files used by Codex are streams of records with this exact
 * structure (the export route pretty-prints one record at a time):
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
