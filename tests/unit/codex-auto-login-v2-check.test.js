import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  testSingleConnection: vi.fn(),
}));

vi.mock("@/models", () => ({
  getProviderConnections: mocks.getProviderConnections,
}));

vi.mock("@/app/api/providers/[id]/test/testUtils.js", () => ({
  testSingleConnection: mocks.testSingleConnection,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init = {}) => new Response(JSON.stringify(body), {
      status: init.status || 200,
      headers: { "content-type": "application/json" },
    }),
  },
}));

const { POST } = await import("../../src/app/api/oauth/codex/auto-login-v2/check/route.js");

function request(body) {
  return new Request("http://localhost/api/oauth/codex/auto-login-v2/check", {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

describe("Codex Auto Login v2 check route", () => {
  beforeEach(() => {
    mocks.getProviderConnections.mockReset();
    mocks.testSingleConnection.mockReset();
  });

  it("accepts an empty body and returns an empty summary when there are no Codex connections", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);

    const response = await POST(request());
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.getProviderConnections).toHaveBeenCalledWith({ provider: "codex" });
    expect(data).toEqual({ results: [], total: 0, checked: 0, failed: 0 });
    expect(mocks.testSingleConnection).not.toHaveBeenCalled();
  });

  it("isolates probe failures, limits concurrency, and preserves connection order", async () => {
    const connections = Array.from({ length: 6 }, (_, index) => ({
      id: `connection-${index + 1}`,
      authType: index % 2 ? "access_token" : "oauth",
      email: `account-${index + 1}@example.com`,
      name: `Account ${index + 1}`,
      accessToken: `secret-${index + 1}`,
      providerSpecificData: { chatgptAccountId: `account-id-${index + 1}` },
    }));
    let active = 0;
    let maxActive = 0;

    mocks.getProviderConnections.mockResolvedValue(connections);
    mocks.testSingleConnection.mockImplementation(async (id) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, (7 - Number(id.at(-1))) * 2));
      active -= 1;
      if (id === "connection-3") throw new Error("Token invalid or revoked");
      return { valid: true, refreshed: id === "connection-2", latencyMs: 12, testedAt: "2026-09-10T00:00:00.000Z" };
    });

    const response = await POST(request({ ignored: true }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(data.results.map((result) => result.id)).toEqual(connections.map((connection) => connection.id));
    expect(data.results[2]).toMatchObject({
      id: "connection-3",
      valid: false,
      error: "Token invalid or revoked",
      refreshed: false,
      latencyMs: 0,
    });
    expect(data.results[0]).not.toHaveProperty("accessToken");
    expect(data.results[0].chatgptAccountId).toBe("account-id-1");
    expect(data).toMatchObject({ total: 6, checked: 6, failed: 1 });
  });

  it("ignores optional request bodies because the check has no options", async () => {
    mocks.getProviderConnections.mockResolvedValue([]);

    const response = await POST(request({ ignored: true }));

    expect(response.status).toBe(200);
    expect(mocks.getProviderConnections).toHaveBeenCalledWith({ provider: "codex" });
  });
});
