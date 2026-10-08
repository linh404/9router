import { NextResponse } from "next/server";
import { deleteProviderConnection, getProviderConnectionById } from "@/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeConnectionIds(body) {
  const raw = body?.connectionIds ?? body?.ids;
  if (!Array.isArray(raw)) return null;

  const ids = [];
  const seen = new Set();
  for (const value of raw) {
    const id = typeof value === "string" ? value.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function handleDelete(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const connectionIds = normalizeConnectionIds(body);
  if (!connectionIds?.length) {
    return NextResponse.json({ error: "connectionIds must contain at least one connection id" }, { status: 400 });
  }

  // Validate the complete target set before mutating anything. This keeps a
  // stale v2 result from deleting a connection that was replaced or from
  // being used as a generic cross-provider bulk-delete endpoint.
  const connections = await Promise.all(connectionIds.map((id) => getProviderConnectionById(id)));
  const invalid = connections
    .map((connection, index) => ({ connection, id: connectionIds[index] }))
    .filter(({ connection }) => !connection || connection.provider !== "codex");
  if (invalid.length) {
    return NextResponse.json(
      {
        error: "Only existing Codex connections can be removed",
        invalidIds: invalid.map(({ id }) => id),
      },
      { status: 400 },
    );
  }

  const deleted = [];
  for (const id of connectionIds) {
    if (await deleteProviderConnection(id)) deleted.push(id);
  }

  return NextResponse.json({ deleted, count: deleted.length });
}

/**
 * POST /api/oauth/codex/auto-login-v2/delete
 * Delete the Codex connection rows whose v2 login attempts failed.
 *
 * DELETE is also accepted so callers can use the conventional HTTP verb while
 * keeping POST available for clients that cannot send a DELETE request body.
 */
export async function POST(request) {
  try {
    return await handleDelete(request);
  } catch (error) {
    console.error("[Codex Auto Login v2] Failed to delete connections:", error);
    return NextResponse.json({ error: error?.message || "Failed to delete Codex connections" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    return await handleDelete(request);
  } catch (error) {
    console.error("[Codex Auto Login v2] Failed to delete connections:", error);
    return NextResponse.json({ error: error?.message || "Failed to delete Codex connections" }, { status: 500 });
  }
}
