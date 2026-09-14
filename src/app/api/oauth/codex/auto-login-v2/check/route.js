import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";
import { testSingleConnection } from "@/app/api/providers/[id]/test/testUtils.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECK_CONCURRENCY = 4;

async function runWithConcurrency(items, worker, limit) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => run()));
  return results;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Connection test failed");
}

function buildResult(connection, tested) {
  return {
    id: connection.id,
    email: connection.email || null,
    name: connection.name || null,
    chatgptAccountId: connection.providerSpecificData?.chatgptAccountId || null,
    valid: tested.valid === true,
    error: tested.error || null,
    refreshed: tested.refreshed === true,
    latencyMs: Number.isFinite(tested.latencyMs) ? tested.latencyMs : 0,
    testedAt: tested.testedAt || new Date().toISOString(),
  };
}

/**
 * POST /api/oauth/codex/auto-login-v2/check
 * Probe every stored Codex connection and return only accounts needing login.
 */
export async function POST() {
  try {
    // Deliberately include inactive rows: the user needs to see every stored
    // account that may require login, while only OAuth-style Codex credentials
    // can be validated by the OAuth probe.
    const allConnections = await getProviderConnections({ provider: "codex" });
    const connections = allConnections.filter(
      (connection) => connection.authType === "oauth" || connection.authType === "access_token",
    );
    const results = await runWithConcurrency(
      connections,
      async (connection) => {
        try {
          return buildResult(connection, await testSingleConnection(connection.id));
        } catch (error) {
          return buildResult(connection, {
            valid: false,
            error: errorMessage(error),
            refreshed: false,
            latencyMs: 0,
            testedAt: new Date().toISOString(),
          });
        }
      },
      CHECK_CONCURRENCY,
    );

    return NextResponse.json({
      results,
      total: results.length,
      checked: results.length,
      failed: results.filter((result) => !result.valid).length,
    });
  } catch (error) {
    console.error("[Codex Auto Login v2] Health check failed:", error);
    return NextResponse.json(
      { error: errorMessage(error) || "Failed to check Codex connections" },
      { status: 500 },
    );
  }
}
