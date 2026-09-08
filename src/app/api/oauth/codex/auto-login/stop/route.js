import { NextResponse } from "next/server";
import {
  pythonServiceErrorStatus,
  stopPythonAutoLogin,
} from "@/lib/oauth/codexPythonService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/oauth/codex/auto-login/stop { jobId } */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body?.jobId || typeof body.jobId !== "string") {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }
  try {
    return NextResponse.json(await stopPythonAutoLogin(body.jobId));
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Failed to stop auto-login" },
      { status: pythonServiceErrorStatus(error) }
    );
  }
}
