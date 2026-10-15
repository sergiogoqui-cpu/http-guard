import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CircuitBreaker,
  CircuitOpenError,
  HttpError,
  NetworkError,
  TimeoutError,
  backoffDelay,
  createGuard,
  parseRetryAfter,
  safeUrl,
  type GuardEvent,
} from "../src/index.ts";

type Step = Response | Error | "hang";

/** A scripted fetch: each call consumes the next step. */
function scripted(steps: Step[]) {
  const calls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    const step = steps.shift() ?? new Response("{}", { status: 200 });
    if (step === "hang") {
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    if (step instanceof Error) throw step;
    return step;
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function make(steps: Step[], opts: Parameters<typeof createGuard>[0] = {}) {
  const { fn, calls } = scripted(steps);
  const sleeps: number[] = [];
  const events: GuardEvent[] = [];
  let t = 1_000_000;
  const guard = createGuard({
    fetch: fn,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    now: () => t,
    random: () => 0.5, // zero jitter offset
    onEvent: (e) => events.push(e),
    ...opts,
  });
  return { guard, calls, sleeps, events, advance: (ms: number) => (t += ms) };
}

describe("retries", () => {
  it("returns JSON on success", async () => {
    const { guard } = make([json({ ok: 1 })]);
    assert.deepEqual(await guard.json("https://api.test/x"), { ok: 1 });
  });

  it("retries 5xx with exponential backoff, then succeeds", async () => {
    const { guard, calls, sleeps } = make([json({}, 503), json({}, 502), json({ ok: 1 })], { baseDelayMs: 100 });
    assert.deepEqual(await guard.json("https://api.test/x"), { ok: 1 });
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [100, 200]);
  });

  it("retries network errors and timeouts", async () => {
    const { guard, calls } = make([new TypeError("fetch failed"), "hang", json({ ok: 1 })], { timeoutMs: 20, baseDelayMs: 1 });
    assert.deepEqual(await guard.json("https://api.test/x"), { ok: 1 });
    assert.equal(calls.length, 3);
  });

  it("honours Retry-After on 429", async () => {
    const { guard, sleeps } = make([json({}, 429, { "retry-after": "7" }), json({ ok: 1 })]);
    await guard.json("https://api.test/x");
    assert.deepEqual(sleeps, [7000]);
  });

  it("does not retry other 4xx", async () => {
    const { guard, calls } = make([json({ error: "nope" }, 401)]);
    await assert.rejects(guard.json("https://api.test/x"), (e: unknown) => e instanceof HttpError && e.status === 401);
    assert.equal(calls.length, 1);
  });

  it("gives up after the configured retries and throws the last error", async () => {
    const { guard, calls } = make([json({}, 500), json({}, 500), json({}, 500)], { retries: 2, baseDelayMs: 1 });
    await assert.rejects(guard.json("https://api.test/x"), HttpError);
    assert.equal(calls.length, 3);
  });

  it("throws TimeoutError / NetworkError once retries are exhausted", async () => {
    const a = make(["hang", "hang"], { retries: 1, timeoutMs: 10, baseDelayMs: 1 });
    await assert.rejects(a.guard.json("https://api.test/x"), TimeoutError);
    const b = make([new TypeError("boom"), new TypeError("boom")], { retries: 1, baseDelayMs: 1 });
    await assert.rejects(b.guard.json("https://api.test/x"), NetworkError);
  });

  it("treatAsEmpty resolves null without retrying", async () => {
    const { guard, calls } = make([json({}, 404)]);
    assert.equal(await guard.json("https://api.test/x", { treatAsEmpty: [404] }), null);
    assert.equal(calls.length, 1);
  });

  it("never retries a caller abort", async () => {
    const { guard, calls } = make(["hang", json({ ok: 1 })]);
    const ac = new AbortController();
    const p = guard.json("https://api.test/x", { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await assert.rejects(p);
    assert.equal(calls.length, 1);
  });
});

describe("circuit breaker", () => {
  const failing = () => Array.from({ length: 20 }, () => json({}, 500));

  it("opens after the threshold and then fails fast without calling the API", async () => {
    const { guard, calls, events } = make(failing(), { retries: 0, breakerThreshold: 3 });
    for (let i = 0; i < 3; i++) await assert.rejects(guard.json("https://api.test/x"), HttpError);
    await assert.rejects(guard.json("https://api.test/x"), CircuitOpenError);
    assert.equal(calls.length, 3);
    assert.ok(events.some((e) => e.type === "circuit" && e.state === "open"));
    assert.equal(guard.breakers()["api.test"].state, "open");
  });

  it("is per host", async () => {
    const { guard } = make([json({}, 500), json({}, 500), json({})], { retries: 0, breakerThreshold: 2 });
    for (let i = 0; i < 2; i++) await assert.rejects(guard.json("https://a.test/x"));
    await assert.rejects(guard.json("https://a.test/x"), CircuitOpenError);
    assert.deepEqual(await guard.json("https://b.test/x"), {}); // other host unaffected
  });

  it("half-opens after the cooldown, closes on a successful probe", async () => {
    const { guard, advance } = make([json({}, 500), json({}, 500), json({ ok: 1 })], {
      retries: 0,
      breakerThreshold: 2,
      breakerCooldownMs: 1000,
    });
    for (let i = 0; i < 2; i++) await assert.rejects(guard.json("https://api.test/x"));
    await assert.rejects(guard.json("https://api.test/x"), CircuitOpenError);
    advance(1001);
    assert.deepEqual(await guard.json("https://api.test/x"), { ok: 1 });
    assert.equal(guard.breakers()["api.test"].state, "closed");
  });

  it("a failed probe reopens the circuit", async () => {
    const { guard, advance } = make(failing(), { retries: 0, breakerThreshold: 1, breakerCooldownMs: 1000 });
    await assert.rejects(guard.json("https://api.test/x"), HttpError);
    advance(1001);
    await assert.rejects(guard.json("https://api.test/x"), HttpError); // probe fails
    await assert.rejects(guard.json("https://api.test/x"), CircuitOpenError);
  });

  it("4xx responses do not trip the breaker", async () => {
    const { guard } = make(Array.from({ length: 10 }, () => json({}, 404)), { retries: 0, breakerThreshold: 2 });
    for (let i = 0; i < 5; i++) await assert.rejects(guard.json("https://api.test/x"), HttpError);
    assert.equal(guard.breakers()["api.test"].state, "closed");
  });

  it("critical calls bypass an open circuit", async () => {
    const { guard, calls } = make([...failing().slice(0, 2), json({ price: 1 })], { retries: 0, breakerThreshold: 2 });
    for (let i = 0; i < 2; i++) await assert.rejects(guard.json("https://api.test/x"));
    await assert.rejects(guard.json("https://api.test/x"), CircuitOpenError);
    assert.deepEqual(await guard.json("https://api.test/x", { critical: true }), { price: 1 });
    assert.equal(calls.length, 3);
  });
});

describe("helpers", () => {
  it("safeUrl removes credentials and query strings", () => {
    assert.equal(safeUrl("https://user:pw@api.test/v1/x?api_key=SECRET&a=1"), "https://api.test/v1/x");
  });

  it("errors never contain query-string secrets", async () => {
    const { guard } = make([json({}, 400)]);
    await assert.rejects(guard.json("https://api.test/x?token=SECRET"), (e: unknown) => !String((e as Error).message).includes("SECRET"));
  });

  it("parseRetryAfter handles seconds, dates and junk", () => {
    assert.equal(parseRetryAfter("3", 0), 3000);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6000);
    assert.equal(parseRetryAfter("soon", 0), null);
    assert.equal(parseRetryAfter(null, 0), null);
  });

  it("backoffDelay grows, caps and jitters within bounds", () => {
    assert.equal(backoffDelay(0, 100, 1000, 0, () => 0.5), 100);
    assert.equal(backoffDelay(10, 100, 1000, 0, () => 0.5), 1000);
    assert.equal(backoffDelay(1, 100, 1000, 0.5, () => 0), 100);
    assert.equal(backoffDelay(1, 100, 1000, 0.5, () => 1), 300);
  });

  it("CircuitBreaker alone: closed -> open -> half-open -> closed", () => {
    let t = 0;
    const b = new CircuitBreaker({ threshold: 2, cooldownMs: 100 }, () => t);
    b.failure();
    assert.equal(b.state(), "closed");
    b.failure();
    assert.equal(b.state(), "open");
    t = 101;
    assert.equal(b.state(), "half-open");
    assert.equal(b.tryAcquire(), true);
    assert.equal(b.tryAcquire(), false); // only one probe in flight
    b.success();
    assert.equal(b.state(), "closed");
  });
});
