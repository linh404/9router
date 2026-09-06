import { getProviderConnections } from "@/models";
import {
  isExportableCodexConnection,
  toCodexImportAccount,
} from "@/lib/oauth/codexExport";

export const dynamic = "force-dynamic";

/**
 * Export current Codex OAuth connections in the portable JSON shape accepted
 * by the dashboard importer and the standalone Codex importer.
 */
export async function GET() {
  try {
    const connections = await getProviderConnections({ provider: "codex" });
    const accounts = connections
      .filter(isExportableCodexConnection)
      .map((connection) => toCodexImportAccount(connection));

    return new Response(JSON.stringify(accounts, null, 2), {
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
