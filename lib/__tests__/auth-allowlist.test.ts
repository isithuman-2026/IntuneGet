import { afterEach, describe, expect, it, vi } from "vitest";
import { isTenantAllowed, parseAccessToken } from "../auth-utils";

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.sig`;
}

describe("isTenantAllowed", () => {
  it("matches case-insensitively with trimmed entries", () => {
    expect(isTenantAllowed("A-1", "a-1, b-2")).toBe(true);
  });
  it("rejects tenants not in the list", () => {
    expect(isTenantAllowed("c-3", "a-1,b-2")).toBe(false);
  });
  it("allows all when the list is unset or empty", () => {
    expect(isTenantAllowed("x", undefined)).toBe(true);
    expect(isTenantAllowed("x", "")).toBe(true);
  });
});

describe("parseAccessToken allowlist", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ALLOWED_TENANT_IDS;
  });

  it("applies the allowlist after the verified-token cache", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "u1", displayName: "U", userPrincipalName: "u@x" }), { status: 200 }))
    );
    const header = `Bearer ${jwt({ tid: "other", exp: Math.floor(Date.now() / 1000) + 3600 })}`;

    process.env.ALLOWED_TENANT_IDS = "mine";
    expect(await parseAccessToken(header)).toBeNull();

    process.env.ALLOWED_TENANT_IDS = "other";
    expect(await parseAccessToken(header)).toMatchObject({ userId: "u1", tenantId: "other" });
  });
});
