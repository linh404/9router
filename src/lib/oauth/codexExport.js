/**
 * Convert a stored Codex OAuth connection to the portable account shape
 * consumed by the Codex importer. Internal settings and refresh failure logs
 * are deliberately excluded from the downloaded credential file.
 */
export function toCodexImportAccount(connection, credentials = connection) {
  const providerSpecificData = connection?.providerSpecificData || {};
  const accessToken = credentials?.accessToken || connection?.accessToken;
  const refreshToken = credentials?.refreshToken || connection?.refreshToken;
  const idToken = credentials?.idToken || connection?.idToken;
  const expiresAt = credentials?.expiresAt || connection?.expiresAt || connection?.tokenExpiresAt;
  const expiresIn = credentials?.expiresIn || connection?.expiresIn;
  const lastRefreshAt = credentials?.lastRefreshAt || connection?.lastRefreshAt;

  return {
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
    ...(connection?.email ? { email: connection.email } : {}),
    ...(connection?.name ? { name: connection.name } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(expiresIn ? { expiresIn } : {}),
    ...(lastRefreshAt ? { lastRefreshAt } : {}),
    ...(providerSpecificData.chatgptAccountId
      ? { account_id: providerSpecificData.chatgptAccountId }
      : {}),
    ...(providerSpecificData.chatgptPlanType
      ? { chatgpt_plan_type: providerSpecificData.chatgptPlanType }
      : {}),
  };
}

export function isExportableCodexConnection(connection) {
  return Boolean(
    connection?.authType === "oauth" &&
    connection?.accessToken &&
    connection?.refreshToken
  );
}
