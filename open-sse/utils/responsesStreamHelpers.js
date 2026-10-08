// Helpers for OpenAI Responses API streaming termination + event framing
import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";

// Responses API events that signal the stream has reached a terminal state
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.done",
  // Responses uses `incomplete` for a valid, provider-reported stop (for
  // example output/context limits). Treat it as terminal instead of replacing
  // the useful upstream reason with a misleading stream-disconnected error.
  "response.incomplete",
  "response.canceled",
  "response.cancelled",
  "response.failed",
  "error"
]);

export function getOpenAIResponsesEventName(eventName, chunk) {
  if (eventName) return eventName;
  if (chunk && typeof chunk.type === "string") return chunk.type;
  // A few gateways omit both `event:` and `type`, leaving only the terminal
  // response status. Restore the lifecycle event so same-format clients still
  // receive `event: response.completed` (rather than a bare data frame).
  const statusEvent = {
    completed: "response.completed",
    incomplete: "response.incomplete",
    failed: "response.failed",
    canceled: "response.canceled",
    cancelled: "response.cancelled",
  }[chunk?.response?.status];
  if (statusEvent) return statusEvent;
  return null;
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (OPENAI_RESPONSES_TERMINAL_EVENTS.has(type)) return true;
  const status = chunk?.response?.status;
  return status === "completed"
    || status === "incomplete"
    || status === "failed"
    || status === "canceled"
    || status === "cancelled";
}

/**
 * Convert a provider-level `event: error` frame into the Responses lifecycle
 * event that Codex clients understand.  `error` is terminal for SSE framing,
 * but it is not a `response.*` event, so Codex waits for response.completed and
 * eventually reports a misleading "stream closed before response.completed".
 */
export function buildOpenAIResponsesFailureEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (type !== "error") return null;

  const sourceError = chunk?.error || chunk?.response?.error || {};
  const sourceResponse = chunk?.response || {};
  const message = typeof sourceError === "string"
    ? sourceError
    : sourceError?.message || chunk?.message || "Responses stream failed";
  const errorType = typeof sourceError === "object" && sourceError?.type
    ? sourceError.type
    : "upstream_error";
  const code = typeof sourceError === "object" && sourceError?.code
    ? sourceError.code
    : undefined;

  return {
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: sourceResponse.id || chunk?.id || `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: errorType,
          ...(code ? { code } : {}),
          message,
        },
      },
    },
  };
}

const sharedEncoder = new TextEncoder();

// Encoded response.failed + [DONE] payload for aborted/stalled Responses passthrough streams
export function buildAbortedResponsesTerminalBytes() {
  return sharedEncoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure()}data: [DONE]\n\n`);
}

// Synthesize a response.failed event for streams that close without a terminal event
export function formatIncompleteOpenAIResponsesStreamFailure() {
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: "stream_error",
          code: "stream_disconnected",
          message: "stream closed before response.completed"
        }
      }
    }
  }, FORMATS.OPENAI_RESPONSES);
}
