import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseCodexUploads } from "../../src/lib/oauth/codexImport.js";

const getProviderConnections = vi.fn();
vi.mock("@/models", () => ({ getProviderConnections }));

const { GET } = await import("../../src/app/api/oauth/codex/export/route.js");

describe("GET /api/oauth/codex/export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("returns a portable flat JSON array without internal settings", async () => {
    const response = await GET();
    const accounts = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("codex-connections-");
    expect(accounts).toEqual([
      expect.objectContaining({
        accessToken: "access-1",
        refreshToken: "refresh-1",
        idToken: "id-1",
        email: "one@example.com",
        name: "Work account",
        expiresAt: "2026-09-16T00:00:00.000Z",
        account_id: "acct-1",
        chatgpt_plan_type: "plus",
      }),
    ]);
    expect(accounts[0]).not.toHaveProperty("providerSpecificData");
    expect(accounts[0]).not.toHaveProperty("autoRefreshDaily");
  });

  it("round-trips through the existing Codex file importer", async () => {
    const response = await GET();
    const exported = await response.json();
    const parsed = parseCodexUploads([{ name: "codex-connections.json", text: JSON.stringify(exported) }]);

    expect(parsed.errors).toEqual([]);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]).toEqual(expect.objectContaining({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      idToken: "id-1",
      email: "one@example.com",
      name: "Work account",
      expiresAt: "2026-09-16T00:00:00.000Z",
    }));
  });
});
