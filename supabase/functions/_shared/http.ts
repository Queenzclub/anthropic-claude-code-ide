// Small HTTP helpers shared by the onboarding Edge Functions: CORS, JSON
// responses, and a strict body reader. No secrets here.

const MAX_BODY_BYTES = 8 * 1024; // onboarding payloads are tiny

// ALLOWED_ORIGIN is an env secret. Production: https://queenzclub.github.io.
// Local dev may set it to a localhost origin. We never reflect an arbitrary
// Origin header.
export function corsHeaders(allowedOrigin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

export function errorResponse(code: string, status: number, cors: Record<string, string>): Response {
  return json({ error: code }, status, cors);
}

// Reads + parses a JSON body, enforcing content-type and a size cap. Returns
// null on any problem (caller maps to invalid_input).
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v as Record<string, unknown> : null;
  } catch (_) {
    return null;
  }
}
