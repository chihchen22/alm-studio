// apps/studio/src/errText.ts
/**
 * A failed call in plain words. The server's reply carries its status and message,
 * printed verbatim; the code stays out of the text (Studio Part 2 D10). A reply with no JSON error body (a proxy failure,
 * the platform down) carries only the HTTP status, which the reader stores as
 * the message "<status> <statusText>" under code "http-error"; that one reads
 * as a sentence naming the status once (Studio Polish 1 F2). A request the
 * network could not deliver (fetch rejects with a TypeError whose text differs
 * by browser) reads as the platform not being reached (Task 8 fix I2).
 */
import { ApiError } from "@alm/reader";

/** The texts a rejected fetch carries: Chrome, Node, Firefox, Safari. */
const NETWORK_FAILURE = /^(Failed to fetch|fetch failed|NetworkError when attempting to fetch resource\.?|Load failed)$/;

/** The reason alone: the server's message, or the sentence for a reply with no reason or no reply at all. */
export function reasonOf(e: unknown): string {
  if (e instanceof ApiError) return e.code === "http-error" ? `The request failed with HTTP ${e.status} and the reply gave no reason.` : e.message;
  if (e instanceof TypeError && NETWORK_FAILURE.test(e.message)) return "The platform could not be reached. Is it running?";
  return e instanceof Error ? e.message : String(e);
}

/** A page's error line: a server reply prints its status and message; anything else prints the reason alone. */
export function pageErrText(e: unknown): string {
  if (e instanceof ApiError && e.code !== "http-error") return `${e.status}: ${e.message}`;
  return reasonOf(e);
}

/** The status and message of a server reply, without its code; the reason alone for anything else (Studio Part 2 D10). */
export function errText(e: unknown): string {
  if (e instanceof ApiError && e.code !== "http-error") return `${e.status}: ${e.message}`;
  return reasonOf(e);
}
