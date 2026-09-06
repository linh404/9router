import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { refreshProviderCredentials } from "open-sse/services/oauthCredentialManager.js";
import { recordCodexRefreshFailure } from "@/sse/services/codexRefreshLog";
import { toCodexImportAccount } from "@/lib/oauth/codexExport";

export const dynamic = "force-dynamic";

function safeError(result) {
  if (!result) return "Refresh failed";
  if (result.error) return String(result.error).slice(0, 240);
  if (result.code) return String(result.code).slice(0, 120);
  return "Refresh failed";
}

function publicResult(connection, status, extra = {}) {
  return {
    id: connection.id,
    name: connection.name || connection.email || connection.id,
    email: connection.email || null,
    status,
    ...extra,
  };
}

function exportAccount(connection, credentials) {
  return toCodexImportAccount(connection, credentials);
}

async function refreshBatch(connections) {
  const byRefreshToken = new Map();
  const refreshOne = (connection) => {
    const key = connection.refreshToken;
    if (!byRefreshToken.has(key)) {
      byRefreshToken.set(
        key,
        refreshProviderCredentials("codex", connection, console)
      );
    }
    return byRefreshToken.get(key);
  };

  return Promise.all(connections.map(async (connection) => {
    try {
      const refreshed = await refreshOne(connection);
      if (!refreshed?.accessToken) {
        const error = safeError(refreshed);
        await recordCodexRefreshFailure(connection.id, {
          error,
          code: refreshed?.code,
          source: "manual",
        });
        return {
          connection,
          result: publicResult(connection, "failed", { error }),
        };
      }

      return {
        connection,
        credentials: refreshed,
        result: publicResult(connection, "success", {
          expiresAt: refreshed.expiresAt || connection.expiresAt || null,
        }),
      };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 240);
      await recordCodexRefreshFailure(connection.id, {
        error: message,
        code: error?.code,
        source: "manual",
      });
      return {
        connection,
        result: publicResult(connection, "failed", {
          error: message,
        }),
      };
    }
  }));
}

/**
 * Refresh every Codex OAuth connection.
 * mode=db persists rotated credentials; mode=json returns a downloadable export.
 */
export async function POST(request) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    // Empty request body is equivalent to the default DB mode.
  }

  const mode = body?.mode || "db";
  if (mode !== "db" && mode !== "json") {
    return NextResponse.json({ error: "mode must be db or json" }, { status: 400 });
  }

  try {
    const allConnections = await getProviderConnections({ provider: "codex" });
    const eligible = allConnections.filter(
      (connection) => connection.authType === "oauth" && connection.refreshToken
    );
    const skipped = allConnections.filter(
      (connection) => connection.authType !== "oauth" || !connection.refreshToken
    );
    const refreshed = await refreshBatch(eligible);

    if (mode === "db") {
      const results = [];
      for (const item of refreshed) {
        if (!item.credentials) {
          results.push(item.result);
          continue;
        }

        const saved = await updateProviderCredentials(item.connection.id, item.credentials);
        if (saved) {
          results.push(item.result);
        } else {
          const result = publicResult(item.connection, "failed", { error: "Failed to save refreshed credentials" });
          await recordCodexRefreshFailure(item.connection.id, {
            error: result.error,
            code: "save_failed",
            source: "manual",
          });
          results.push(result);
        }
      }

      results.push(...skipped.map((connection) => publicResult(connection, "skipped", {
        error: "No OAuth refresh token",
      })));

      const summary = {
        total: allConnections.length,
        success: results.filter((item) => item.status === "success").length,
        failed: results.filter((item) => item.status === "failed").length,
        skipped: results.filter((item) => item.status === "skipped").length,
      };
      return NextResponse.json({ mode, summary, results });
    }

    const accounts = refreshed
      .filter((item) => item.credentials)
      .map((item) => exportAccount(item.connection, item.credentials));
    const results = [
      ...refreshed.map((item) => item.result),
      ...skipped.map((connection) => publicResult(connection, "skipped", {
        error: "No OAuth refresh token",
      })),
    ];
    const summary = {
      total: allConnections.length,
      success: results.filter((item) => item.status === "success").length,
      failed: results.filter((item) => item.status === "failed").length,
      skipped: results.filter((item) => item.status === "skipped").length,
    };

    const payload = JSON.stringify({ accounts, summary, results }, null, 2);
    return new Response(payload, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="codex-refreshed-${new Date().toISOString().slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Codex bulk refresh failed:", error?.message || error);
    return NextResponse.json({ error: "Failed to refresh Codex connections" }, { status: 500 });
  }
}
