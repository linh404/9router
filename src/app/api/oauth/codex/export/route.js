import { getProviderConnections } from "@/models";
import {
  isExportableCodexConnection,
  toCodexImportAccount,
} from "@/lib/oauth/codexExport";

export const dynamic = "force-dynamic";

/**
 * Export current Codex OAuth connections in the native Codex stream format.
 * Each account is a pretty-printed JSON object; objects are separated by a
 * newline and there is no surrounding array, matching the files produced by
 * the Codex tooling.
 */
export async function GET() {
  try {
    const connections = await getProviderConnections({ provider: "codex" });
    const accounts = connections
      .filter(isExportableCodexConnection)
      .map((connection) => toCodexImportAccount(connection));

    const payload = accounts.map((account) => JSON.stringify(account, null, 2)).join("\n");

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
