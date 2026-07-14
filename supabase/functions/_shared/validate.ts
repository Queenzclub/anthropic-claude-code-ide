// Pure, dependency-free validation + normalization + safe error mapping for
// company onboarding. No Deno/Supabase imports so it can be unit-tested under
// any JS runtime. The DATABASE re-normalizes and owns the request fingerprint;
// this layer is for early rejection + UX only.

export interface RawInput {
  company_name?: unknown;
  company_code?: unknown;
  timezone?: unknown;
  first_admin_name?: unknown;
  first_admin_email?: unknown;
  idempotency_key?: unknown;
}

export interface NormalizedInput {
  company_name: string;
  company_code: string;
  timezone: string;
  first_admin_name: string;
  first_admin_email: string;
  idempotency_key: string;
}

// Approved company-code shape: A-Z0-9 start, then A-Z0-9/'-', total 3..32.
export const COMPANY_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
// Minimal email shape (Auth is the real validator).
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function normalizeEmail(v: unknown): string {
  return str(v).toLowerCase();
}

export function normalizeCode(v: unknown): string {
  return str(v).toUpperCase();
}

// Returns { ok, value } or { ok:false, error:'invalid_input' }. Never throws.
export function validateInput(
  raw: RawInput,
): { ok: true; value: NormalizedInput } | { ok: false; error: "invalid_input" } {
  const company_name = str(raw.company_name);
  const company_code = normalizeCode(raw.company_code);
  const timezone = str(raw.timezone);
  const first_admin_name = str(raw.first_admin_name);
  const first_admin_email = normalizeEmail(raw.first_admin_email);
  const idempotency_key = str(raw.idempotency_key);

  if (
    !company_name || !first_admin_name ||
    !COMPANY_CODE_RE.test(company_code) ||
    !EMAIL_RE.test(first_admin_email) ||
    !UUID_RE.test(idempotency_key) ||
    !timezone || timezone.length > 64
  ) {
    return { ok: false, error: "invalid_input" };
  }
  return {
    ok: true,
    value: { company_name, company_code, timezone, first_admin_name, first_admin_email, idempotency_key },
  };
}

// The safe error codes this function ever returns to the browser.
export const SAFE_ERRORS = new Set([
  "invalid_input", "not_allowed", "company_code_exists", "email_already_linked",
  "onboarding_in_progress", "idempotency_conflict", "invitation_failed",
  "setup_email_failed", "retry_required", "onboarding_failed",
]);

// Map an internal error message (from an RPC RAISE or a thrown error) to a safe
// code. Anything unrecognized collapses to a generic code — never leak raw
// Postgres/Auth text.
export function toSafeError(message: unknown): string {
  const m = typeof message === "string" ? message : "";
  // RPCs raise the safe code verbatim (e.g. 'company_code_exists').
  for (const code of SAFE_ERRORS) {
    if (m === code) return code;
  }
  if (/permission denied/i.test(m)) return "not_allowed";
  return "onboarding_failed";
}

// Classifications the DB may return for the onboarding email.
export const SAFE_TO_LINK = new Set(["unlinked_inactive", "linked_this_company_admin"]);
export const UNSAFE_CLASSIFICATIONS = new Set([
  "linked_other_company", "is_app_admin", "active_other_role",
]);
