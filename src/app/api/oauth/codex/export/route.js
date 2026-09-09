import { getProviderConnections } from "@/models";
import {
  fetchCodexPrimaryResetAt,
  isExportableCodexConnection,
  sortCodexExportRecords,
  toCodexImportAccount,
} from "@/lib/oauth/codexExport";

export const dynamic = "force-dynamic";

const MAX_USAGE_CHECKS = 4;

async function rankConnectionsByReset(exportable) {
  const ranked = new Array(exportable.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= exportable.length) return;

      const connection = exportable[index];
      let reset = null;
      let exportConnection = connection;
      try {
        const result = await fetchCodexPrimaryResetAt(connection);
        reset = result;
        exportConnection = result?.connection || connection;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[Codex export] Usage unavailable for ${connection.email || connection.id}: ${message}`);
      }
      // Preserve source order for stable ordering of failed/missing checks.
      ranked[index] = { connection: exportConnection, reset };
    }
  }

  const workerCount = Math.min(MAX_USAGE_CHECKS, exportable.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return ranked;
}

/**
 * Export current Codex OAuth connections in the same account-record shape used
 * by the dashboard's Import JSON flow.  The top-level array keeps the file a
 * single valid JSON document while every item remains compatible with native
 * Codex records (`email`, `password`, `2fa`, and `tokens.*`).
 */
export async function GET() {
  try {
    const connections = await getProviderConnections({ provider: "codex" });
    const exportable = connections.filter(isExportableCodexConnection);
    const ranked = await rankConnectionsByReset(exportable);
    const accounts = sortCodexExportRecords(ranked)
      .map(({ connection }) => toCodexImportAccount(connection));

    const payload = JSON.stringify(accounts, null, 2);

    return new Response(payload, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="codex-connections-${new Date().toISOString().slice(0, 10)}.json"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Codex connection export failed:", error?.message || error);
    return Response.json({ error: "Failed to export Codex connections" }, { status: 500 });
  }
}
