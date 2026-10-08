import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  deleteProviderConnection: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnectionById: mocks.getProviderConnectionById,
  deleteProviderConnection: mocks.deleteProviderConnection,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => new Response(JSON.stringify(body), {
      status: init.status || 200,
      headers: { "content-type": "application/json" },
    }),
  },
}));

const { DELETE, POST } = await import("../../src/app/api/oauth/codex/auto-login-v2/delete/route.js");
const { parseAccounts } = await import("../../src/lib/oauth/codexAutoLogin/index.js");

function request(method, body) {
  return new Request("http://localhost/api/oauth/codex/auto-login-v2/delete", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Codex Auto Login v2 delete route", () => {
  beforeEach(() => {
    mocks.getProviderConnectionById.mockReset();
    mocks.deleteProviderConnection.mockReset();
  });

  it("deletes only existing Codex rows and deduplicates ids", async () => {
    mocks.getProviderConnectionById.mockImplementation(async (id) => ({ id, provider: "codex" }));
    mocks.deleteProviderConnection.mockResolvedValue(true);

    const response = await POST(request("POST", { connectionIds: ["codex-1", "codex-1", "codex-2"] }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.deleteProviderConnection).toHaveBeenCalledTimes(2);
    expect(mocks.deleteProviderConnection).toHaveBeenNthCalledWith(1, "codex-1");
    expect(mocks.deleteProviderConnection).toHaveBeenNthCalledWith(2, "codex-2");
    expect(data).toEqual({ deleted: ["codex-1", "codex-2"], count: 2 });
  });

  it("rejects a missing or non-Codex target before deleting any row", async () => {
    mocks.getProviderConnectionById.mockImplementation(async (id) => (
      id === "other-1" ? { id, provider: "openai" } : null
    ));

    const response = await DELETE(request("DELETE", { ids: ["other-1", "missing-1"] }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.invalidIds).toEqual(["other-1", "missing-1"]);
    expect(mocks.deleteProviderConnection).not.toHaveBeenCalled();
  });

  it("requires at least one connection id", async () => {
    const response = await POST(request("POST", { connectionIds: [] }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toContain("connectionIds");
    expect(mocks.getProviderConnectionById).not.toHaveBeenCalled();
  });

  it("preserves a supplied connection id for v2 login result cleanup", () => {
    expect(parseAccounts([{
      id: "connection-42",
      email: "account@example.com",
      password: "password",
      totpSecret: "totp",
    }])).toEqual([{
      id: "connection-42",
      email: "account@example.com",
      password: "password",
      totpSecret: "totp",
    }]);
  });
});
