import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCodexUploads } from "../../src/lib/oauth/codexImport.js";

const getProviderConnections = vi.fn();
const getUsageForProvider = vi.fn();
const refreshAndUpdateCredentials = vi.fn();
vi.mock("@/models", () => ({ getProviderConnections }));
vi.mock("open-sse/services/usage.js", () => ({ getUsageForProvider }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
}));
vi.mock("@/lib/oauth/refreshCredentials", () => ({ refreshAndUpdateCredentials }));

const { GET } = await import("../../src/app/api/oauth/codex/export/route.js");

describe("GET /api/oauth/codex/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshAndUpdateCredentials.mockImplementation(async (connection) => ({ connection, refreshed: false }));
    getUsageForProvider.mockResolvedValue({ quotas: { session: { resetAt: null } } });
    getProviderConnections.mockResolvedValue([
      {
        id: "conn-1",
        provider: "codex",
        authType: "oauth",
        name: "Work account",
        email: "one@example.com",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        idToken: "id-1",
        expiresAt: "2026-09-16T00:00:00.000Z",
        providerSpecificData: {
          chatgptAccountId: "acct-1",
          chatgptPlanType: "plus",
          autoRefreshDaily: true,
          codexRefreshFailures: [{ error: "do not export" }],
          connectionProxyUrl: "https://proxy.invalid",
        },
      },
      { id: "api-1", provider: "codex", authType: "apikey", apiKey: "secret" },
      { id: "missing-refresh", provider: "codex", authType: "oauth", accessToken: "access-2" },
    ]);
  });

  it("returns native Codex records without internal settings", async () => {
    const response = await GET();
    const raw = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("codex-connections-");
    expect(raw.trimStart().startsWith("{")).toBe(true);
    expect(raw.trimStart().startsWith("[")).toBe(false);
    expect(raw).toContain('"OPENAI_API_KEY"');
    expect(raw).toContain('"tokens"');
    expect(raw).toContain('"access_token": "access-1"');
    expect(raw).not.toContain("autoRefreshDaily");
    expect(raw).not.toContain("connectionProxyUrl");
  });

  it("round-trips through the existing Codex file importer", async () => {
    const response = await GET();
    const exported = await response.text();
    const parsed = parseCodexUploads([{ name: "codex-connections.json", text: exported }]);

    expect(parsed.errors).toEqual([]);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]).toEqual(expect.objectContaining({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      idToken: "id-1",
      email: "one@example.com",
      name: "one@example.com",
      providerSpecificData: expect.objectContaining({
        chatgptAccountId: "acct-1",
      }),
    }));
  });

  it("accepts native nested records and pretty adjacent JSON objects", () => {
    const record = (suffix) => ({
      "2fa": `two-factor-${suffix}`,
      OPENAI_API_KEY: null,
      email: `${suffix}@example.com`,
      last_refresh: "2026-09-01T00:00:00Z",
      password: `password-${suffix}`,
      tokens: {
        access_token: `access-${suffix}`,
        account_id: `account-${suffix}`,
        id_token: `id-${suffix}`,
        refresh_token: `refresh-${suffix}`,
      },
    });
    const text = [record("one"), record("two")]
      .map((value) => JSON.stringify(value, null, 2))
      .join("\n");

    const parsed = parseCodexUploads([{ name: "native.json", text }]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.accounts[0]).toEqual(expect.objectContaining({
      email: "one@example.com",
      lastRefreshAt: "2026-09-01T00:00:00Z",
      providerSpecificData: expect.objectContaining({
        "2fa": "two-factor-one",
        password: "password-one",
      }),
    }));
  });

  it("refreshes usage for every exportable account and sorts by primary reset", async () => {
    getProviderConnections.mockResolvedValue([
      {
        id: "later",
        provider: "codex",
        authType: "oauth",
        email: "later@example.com",
        accessToken: "access-later",
        refreshToken: "refresh-later",
        providerSpecificData: {},
      },
      {
        id: "earlier",
        provider: "codex",
        authType: "oauth",
        email: "earlier@example.com",
        accessToken: "access-earlier",
        refreshToken: "refresh-earlier",
        providerSpecificData: {},
      },
      {
        id: "missing",
        provider: "codex",
        authType: "oauth",
        email: "missing@example.com",
        accessToken: "access-missing",
        refreshToken: "refresh-missing",
        providerSpecificData: {},
      },
    ]);
    getUsageForProvider.mockImplementation(async (connection, _proxy, options) => {
      expect(options).toEqual({ force: true });
      if (connection.id === "earlier") return { quotas: { session: { resetAt: "2026-09-10T00:00:00.000Z" } } };
      if (connection.id === "later") return { quotas: { session: { resetAt: "2026-09-12T00:00:00.000Z" } } };
      return { quotas: { session: { resetAt: null } } };
    });

    const response = await GET();
    const raw = await response.text();
    const emails = [...raw.matchAll(/"email": "([^"]+)"/g)].map((match) => match[1]);

    expect(emails).toEqual(["earlier@example.com", "later@example.com", "missing@example.com"]);
    expect(getUsageForProvider).toHaveBeenCalledTimes(3);
    expect(refreshAndUpdateCredentials).toHaveBeenCalledTimes(3);
  });
});
