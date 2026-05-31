// relay/test/cors.test.ts
import { describe, expect, it } from "vitest";
import { corsHeaders } from "../src/cors";

function reqFrom(origin: string | null): Request {
  const headers = origin ? { Origin: origin } : undefined;
  return new Request("https://relay.test/whatever", { headers });
}

describe("corsHeaders", () => {
  it("locks origin to ALLOWED_ORIGIN when caller origin differs", () => {
    const h = corsHeaders(reqFrom("https://evil.example"), {
      ALLOWED_ORIGIN: "https://app.example",
    });
    expect(h["Access-Control-Allow-Origin"]).toBe("https://app.example");
  });

  it("echoes the matching origin when it equals ALLOWED_ORIGIN", () => {
    const h = corsHeaders(reqFrom("https://app.example"), {
      ALLOWED_ORIGIN: "https://app.example",
    });
    expect(h["Access-Control-Allow-Origin"]).toBe("https://app.example");
  });

  it("falls back to '*' when ALLOWED_ORIGIN is set but request has no Origin", () => {
    const h = corsHeaders(reqFrom(null), { ALLOWED_ORIGIN: "https://app.example" });
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("echoes any origin when ALLOWED_ORIGIN is unset (dev)", () => {
    const h = corsHeaders(reqFrom("http://localhost:5173"), {});
    expect(h["Access-Control-Allow-Origin"]).toBe("http://localhost:5173");
  });

  it("uses '*' when ALLOWED_ORIGIN is unset and no Origin header", () => {
    const h = corsHeaders(reqFrom(null), {});
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("always includes Methods, Headers, and Max-Age", () => {
    const h = corsHeaders(reqFrom(null), {});
    expect(h["Access-Control-Allow-Methods"]).toMatch(/GET/);
    expect(h["Access-Control-Allow-Methods"]).toMatch(/POST/);
    expect(h["Access-Control-Allow-Methods"]).toMatch(/OPTIONS/);
    expect(h["Access-Control-Allow-Headers"]).toMatch(/Content-Type/);
    expect(h["Access-Control-Max-Age"]).toBeTruthy();
  });
});
