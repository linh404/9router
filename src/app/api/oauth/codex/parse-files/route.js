import { NextResponse } from "next/server";
import { parseCodexUploads } from "@/lib/oauth/codexImport";

/**
 * POST /api/oauth/codex/parse-files
 *
 * Parses uploaded Codex/ChatGPT token FILES (JSON objects, JSONL, or base64
 * ZIP bundles) into accounts compatible with /api/oauth/codex/bulk-import,
 * WITHOUT writing anything to the DB. The UI shows the preview table from the
 * response, then sends `accounts` to bulk-import when the user confirms.
 *
 * Body: { files: [{ name, text?, zip? }] }  (zip = base64-encoded archive)
 * Response: { accounts, preview, errors } — tokens are never echoed back.
 */
const MAX_FILES = 200;

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid JSON body: ${err.message}` },
      { status: 400 }
    );
  }

  const files = body?.files;
  if (!Array.isArray(files) || files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json(
      { error: `Too many files (max ${MAX_FILES})` },
      { status: 400 }
    );
  }

  try {
    const { accounts, preview, errors } = parseCodexUploads(files);
    return NextResponse.json({ accounts, preview, errors });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Parse failed" },
      { status: 500 }
    );
  }
}
