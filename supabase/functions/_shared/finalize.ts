// Pure, dependency-free helpers for complete-first-admin-setup. No Deno/Supabase
// imports so they can be unit-tested under any JS runtime. The database RPC
// finalize_first_admin_setup() is the security authority; this layer only maps
// its known-safe outcome codes to HTTP responses and shapes the safe result.

export interface FinalizeMapped {
  code: string;
  status: number;
}

// Map ONLY known-safe RPC error codes; anything else collapses to setup_failed
// so raw Postgres/Auth text can never leak to the browser.
export function mapFinalizeError(rpcMessage: unknown): FinalizeMapped {
  const code = typeof rpcMessage === "string" ? rpcMessage : "";
  if (code === "not_allowed") return { code: "not_allowed", status: 403 };
  if (code === "setup_proof_required") return { code: "setup_proof_required", status: 401 };
  return { code: "setup_failed", status: 422 };
}

// Shape the success body: safe fields only, never the company_id or any secret.
export function safeFinalizeResult(rpcData: unknown): { finalized: true; already_completed: boolean } {
  const already = !!(rpcData && typeof rpcData === "object" &&
    (rpcData as { already_completed?: unknown }).already_completed === true);
  return { finalized: true, already_completed: already };
}
