/**
 * Shared HTTP helpers for Route Handlers.
 *
 * This file lives under app/api so it is NOT an adapter import.
 * (Verifier check: `grep '@/lib/adapters' web/app/api` should be empty.)
 */
import { LockBusyError } from "@/lib/ports";
import { DomainError } from "@/lib/types";

export function handleError(e: unknown): Response {
  if (e instanceof LockBusyError) {
    return new Response(JSON.stringify({ error: "busy", details: e.message }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  }
  if (e instanceof DomainError) {
    const status =
      e.code === "not_found"
        ? 404
        : e.code === "lock_busy"
          ? 409
          : e.code === "invalid_input" || e.code === "invalid_state"
            ? 400
            : 500;
    return new Response(
      JSON.stringify({ error: e.code, message: e.message }),
      { status, headers: { "content-type": "application/json" } },
    );
  }
  // eslint-disable-next-line no-console
  console.error("[route]", e);
  return new Response(
    JSON.stringify({ error: "internal", message: (e as Error)?.message ?? "error" }),
    { status: 500, headers: { "content-type": "application/json" } },
  );
}
