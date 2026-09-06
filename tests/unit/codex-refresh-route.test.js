import { beforeEach, describe, expect, it, vi } from "vitest";

const getProviderConnections = vi.fn();
const updateProviderCredentials = vi.fn();
const refreshProviderCredentials = vi.fn();

vi.mock("@/models", () => ({ getProviderConnections }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials }));
vi.mock("open-sse/services/oauthCredentialManager.js", () => ({ refreshProviderCredentials }));

const { POST } = await import("../../src/app/api/oauth/codex/refresh/route.js");

const oauthConnection = {
  id: "conn-1",
  provider: "codex",
  authType: "oauth",
  name: "Account 1",
  email: "one@example.com",
  refreshToken: "refresh-1",
  expiresAt: "2026-09-10T00:00:00.000Z",
  isActive: true,
};

describe("POST /api/oauth/codex/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProviderConnections.mockResolvedValue([
      oauthConnection,
      { id: "conn-2", provider: "codex", authType: "apikey", name: "API" },
    ]);
    refreshProviderCredentials.mockResolvedValue({
      accessToken: "access-new",
      refreshToken: "refresh-new",
      idToken: "id-new",
      expiresIn: 86400,
      expiresAt: "2026-09-11T00:00:00.000Z",
      lastRefreshAt: "2026-09-06T00:00:00.000Z",
    });
    updateProviderCredentials.mockResolvedValue(true);
  });

  it("refreshes OAuth connections and persists only in DB mode", async () => {
    const response = await POST(new Request("http://localhost/api/oauth/codex/refresh", {
      method: "POST",
      body: JSON.stringify({ mode: "db" }),
      headers: { "Content-Type": "application/json" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.summary).toEqual({ total: 2, success: 1, failed: 0, skipped: 1 });
    expect(updateProviderCredentials).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({ accessToken: "access-new", refreshToken: "refresh-new" })
    );
    expect(body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "conn-1", status: "success" }),
      expect.objectContaining({ id: "conn-2", status: "skipped" }),
    ]));
  });

  it("returns a JSON export without writing to DB", async () => {
    const response = await POST(new Request("http://localhost/api/oauth/codex/refresh", {
      method: "POST",
      body: JSON.stringify({ mode: "json" }),
      headers: { "Content-Type": "application/json" },
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("codex-refreshed-");
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toEqual(expect.objectContaining({
      accessToken: "access-new",
      refreshToken: "refresh-new",
    }));
    expect(updateProviderCredentials).not.toHaveBeenCalled();
  });
});
