import { NextResponse } from "next/server";
import { parseAccounts } from "@/lib/oauth/codexAutoLogin";
import {
  getPythonAutoLogin,
  pythonServiceErrorStatus,
  startPythonAutoLogin,
} from "@/lib/oauth/codexPythonService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/oauth/codex/auto-login
 * Body: { accounts: "email|password|totp\\n..." | [{ email, password, totpSecret }], workers? }
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const accounts = parseAccounts(body?.accounts ?? body?.accountList ?? body?.lines);
    const job = await startPythonAutoLogin({
      accounts,
      workers: body?.workers ?? body?.concurrency,
      headed: body?.headed === true || body?.showBrowser === true,
    });
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to start auto-login" },
      { status: pythonServiceErrorStatus(error) }
    );
  }
}

/**
 * GET /api/oauth/codex/auto-login?jobId=...
 */
export async function GET(request) {
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  try {
    return NextResponse.json(await getPythonAutoLogin(jobId));
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to read auto-login status" },
      { status: pythonServiceErrorStatus(error) }
    );
  }
}
