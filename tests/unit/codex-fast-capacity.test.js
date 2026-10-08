import { describe, expect, it } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("Codex fast tier and capacity handling", () => {
  it("maps Codex fast tier to priority and max reasoning to xhigh", () => {
    const executor = new CodexExecutor();
    const body = executor.transformRequest("gpt-5.5", {
      model: "gpt-5.5",
      input: "hi",
      reasoning_effort: "max",
      service_tier: "fast",
    }, true, {});

    expect(body.service_tier).toBe("priority");
    expect(body.reasoning.effort).toBe("xhigh");
  });

  it("uses ChatGPT workspace header fallback", () => {
    const executor = new CodexExecutor();
    const headers = executor.buildHeaders({
      accessToken: "token",
      connectionId: "conn_1",
      providerSpecificData: { chatgptAccountId: "acct_1" },
    });

    expect(headers["ChatGPT-Account-ID"]).toBe("acct_1");
  });

  it("classifies 200-SSE model capacity as account fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"message":"Selected model is at capacity. Please try a different model."}}',
      "",
    ].join("\n")), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.accountFallback).toBe(true);
    expect(peek.message).toBe("Selected model is at capacity. Please try a different model.");
  });

  it("classifies an initial revoked-token SSE error for account fallback", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"code":"refresh_token_invalidated","message":"The refresh token has been invalidated."}}',
      "",
    ].join("\n")), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBe("upstream_sse_error");
    expect(peek.accountFallback).toBe(true);
    expect(peek.errorStatus).toBe(401);
    expect(peek.retryable).toBe(false);
  });

  it("returns a non-retryable 400 classification for invalid request SSE errors", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"code":"context_length_exceeded","message":"Input exceeds context length."}}',
      "",
    ].join("\n")), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.errorStatus).toBe(400);
    expect(peek.accountFallback).toBe(false);
    expect(peek.retryable).toBe(false);
  });

  it("keeps unknown initial SSE errors retryable as 503", async () => {
    const executor = new CodexExecutor();
    const response = new Response(streamFromText([
      "event: error",
      'data: {"error":{"message":"Temporary upstream failure."}}',
      "",
    ].join("\n")), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.errorStatus).toBe(503);
    expect(peek.accountFallback).toBe(false);
    expect(peek.retryable).toBe(true);
  });

  it("does not classify a late SSE error after a response has started", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_test"}}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      "",
      "event: error",
      'data: {"error":{"message":"Temporary upstream failure."}}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("does not treat capacity wording inside output text as account fallback", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"Selected model is at capacity. Please try a different model."}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), { status: 200, headers: { "Content-Type": "text/event-stream" } });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    expect(peek.accountFallback).toBe(false);
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });

  it("reassembles normal SSE after peeking", async () => {
    const executor = new CodexExecutor();
    const text = [
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"OK"}',
      "",
    ].join("\n");
    const response = new Response(streamFromText(text), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });

    const peek = await executor._peekSseTransientError(response);
    expect(peek.matched).toBeNull();
    await expect(new Response(peek.replacementBody).text()).resolves.toBe(text);
  });
});

describe("Codex reasoning normalization", () => {
  it.each([
    ["gpt-5.6-sol", "max", "max"],
    ["gpt-5.6-sol", "ultra", "ultra"],
    ["gpt-5.6-terra", "max", "max"],
    ["gpt-5.6-terra", "ultra", "ultra"],
    ["gpt-5.6-luna", "max", "max"],
    ["gpt-5.6-luna", "ultra", "max"],
  ])("normalizes %s effort %s to %s", (model, effort, expected) => {
    const body = new CodexExecutor().transformRequest(model, {
      model,
      input: "hi",
      reasoning: { effort },
    }, true, {});

    expect(body.reasoning.effort).toBe(expected);
  });

  it("resolves review models before applying the reasoning matrix", () => {
    const body = new CodexExecutor().transformRequest("gpt-5.6-terra-review", {
      model: "gpt-5.6-terra-review",
      input: "hi",
      reasoning_effort: "ultra",
    }, true, {});

    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.reasoning.effort).toBe("ultra");
  });
});
