import { NextResponse } from "next/server";
import { getProviderConnections } from "@/models";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { refreshProviderCredentials } from "open-sse/services/oauthCredentialManager.js";

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
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    priority: _priority,
    ...metadata
  } = connection;

  return {
    ...metadata,
    provider: "codex",
    authType: "oauth",
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken || connection.refreshToken,
    idToken: credentials.idToken || connection.idToken || null,
    expiresIn: credentials.expiresIn || null,
    expiresAt: credentials.expiresAt || connection.expiresAt || null,
    lastRefreshAt: credentials.lastRefreshAt || new Date().toISOString(),
    testStatus: "active",
    isActive: connection.isActive !== false,
  };
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
        return {
          connection,
          result: publicResult(connection, "failed", { error: safeError(refreshed) }),
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
      return {
        connection,
        result: publicResult(connection, "failed", {
          error: String(error?.message || error).slice(0, 240),
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
        results.push(saved
          ? item.result
          : publicResult(item.connection, "failed", { error: "Failed to save refreshed credentials" }));
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
