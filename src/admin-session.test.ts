import {
  mintSessionToken,
  verifySessionToken,
  parseCookies,
  LoginRateLimiter,
  SESSION_TTL_MS,
} from "./admin-session.js";

const SECRET = "test-admin-secret";

describe("admin session tokens", () => {
  test("mint → verify roundtrip", () => {
    const token = mintSessionToken(SECRET);
    expect(verifySessionToken(token, SECRET)).toBe(true);
  });

  test("rejects expired tokens", () => {
    const past = new Date(Date.now() - SESSION_TTL_MS - 1000);
    const token = mintSessionToken(SECRET, past);
    expect(verifySessionToken(token, SECRET)).toBe(false);
  });

  test("rejects tampered expiry", () => {
    const token = mintSessionToken(SECRET);
    const parts = token.split(".");
    parts[1] = String(Number(parts[1]) + 9_999_999);
    expect(verifySessionToken(parts.join("."), SECRET)).toBe(false);
  });

  test("rejects tokens minted with a different secret", () => {
    const token = mintSessionToken("other-secret");
    expect(verifySessionToken(token, SECRET)).toBe(false);
  });

  test("rejects garbage", () => {
    expect(verifySessionToken("", SECRET)).toBe(false);
    expect(verifySessionToken("v1.abc.def", SECRET)).toBe(false);
    expect(verifySessionToken("v0.123.n.mac", SECRET)).toBe(false);
  });
});

describe("parseCookies", () => {
  test("parses multiple cookies and ignores malformed pairs", () => {
    expect(parseCookies("a=1; admin_session=tok%2Fen; malformed; b=2")).toEqual({
      a: "1",
      admin_session: "tok/en",
      b: "2",
    });
    expect(parseCookies(undefined)).toEqual({});
  });
});

describe("LoginRateLimiter", () => {
  test("blocks after max failures within the window and recovers after it", () => {
    let clock = 1_000_000;
    const limiter = new LoginRateLimiter(3, 60_000, () => clock);
    expect(limiter.isBlocked("ip")).toBe(false);
    limiter.recordFailure("ip");
    limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(false);
    limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(true);
    clock += 61_000;
    expect(limiter.isBlocked("ip")).toBe(false);
  });

  test("reset clears the budget", () => {
    const limiter = new LoginRateLimiter(1, 60_000);
    limiter.recordFailure("ip");
    expect(limiter.isBlocked("ip")).toBe(true);
    limiter.reset("ip");
    expect(limiter.isBlocked("ip")).toBe(false);
  });
});
