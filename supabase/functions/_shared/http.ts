// Small HTTP helpers for the Edge Functions.

export function corsHeaders(origin: string | undefined): Record<string, string> {
  return {
    'access-control-allow-origin': origin ?? '',
    'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } });
}

/** Reads a required environment variable without ever printing its value. */
export function requireEnv(get: (k: string) => string | undefined, name: string): string {
  const v = get(name);
  if (!v) throw new Error(`Missing configuration: ${name}`);
  return v;
}
