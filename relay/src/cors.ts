// relay/src/cors.ts
// Same-origin deploy needs no CORS. When `ALLOWED_ORIGIN` is set we restrict to
// that single origin (and fall back to `*` when there's no Origin header, e.g.
// same-origin browser fetches). With no `ALLOWED_ORIGIN` (local dev) we echo
// the request Origin — the relay only ever stores opaque SDP, so this is safe.
export function corsHeaders(
  req: Request,
  env: { ALLOWED_ORIGIN?: string },
): Record<string, string> {
  const reqOrigin = req.headers.get("Origin");
  let allow: string;
  if (env.ALLOWED_ORIGIN) {
    if (!reqOrigin) allow = "*";
    else allow = reqOrigin === env.ALLOWED_ORIGIN ? reqOrigin : env.ALLOWED_ORIGIN;
  } else {
    allow = reqOrigin ?? "*";
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
