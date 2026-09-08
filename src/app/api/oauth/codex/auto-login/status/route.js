import { NextResponse } from "next/server";
import {
  getPythonAutoLogin,
  pythonServiceErrorStatus,
} from "@/lib/oauth/codexPythonService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/oauth/codex/auto-login/status?jobId=... */
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
