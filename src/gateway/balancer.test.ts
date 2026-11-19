/**
 * Route balancer contracts (specs/domains/load-balancing.md): deterministic
 * round-robin and weighted round-robin sequences, per-route health — failure
 * classification, the consecutive-failure threshold opening a route, skip
 * semantics, cooldown expiry followed by the single half-open probe — and
 * the tried-set that drives within-request failover. Time is injected, so
 * every cooldown transition is deterministic.
 */
import { describe, expect, test } from "bun:test";
import type pino from "pino";
import type { Upstream, UpstreamConfig, ModelEntry, ProxyRequest } from "../upstreams/upstream.ts";
import { UpstreamRegistry, type UpstreamFactories } from "../upstreams/registry.ts";
import type { ModelConfig, ModelRouteConfig } from "../config/schema.ts";
import {
  createRouteBalancer,
  isPreFirstByteFailure,
  AFFINITY_MAX_ENTRIES,
  ROUTE_COOLDOWN_MS,
  ROUTE_FAILURE_THRESHOLD,
  type RouteSelection,
} from "./balancer.ts";

function fakeLogger(): pino.Logger {
  const noop = () => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => fakeLogger(),
  } as unknown as pino.Logger;
}

function entry(id: string): UpstreamConfig {
  return { type: "openai-compatible", id, baseUrl: "https://upstream.example/v1", apiKey: "sk-test" };
}

class NullUpstream implements Upstream {
  readonly id: string;
  readonly type: UpstreamConfig["type"] = "openai-compatible";

  constructor(config: UpstreamConfig) {
    this.id = config.id;
  }

  async connect(): Promise<void> {}
  async listModels(): Promise<ModelEntry[]> {
    return [];
  }
  async forward(_request: ProxyRequest): Promise<Response> {
    return new Response(null, { status: 204 });
  }
}

async function registryWith(...ids: string[]) {
  const map = new Map(ids.map((id) => [id, new NullUpstream(entry(id))]));
  const factories: UpstreamFactories = {
    "openai-compatible": (config) => {
      const made = map.get(config.id);
      if (made === undefined) throw new Error(`unexpected id ${config.id}`);
      return made;
    },
  };
  return UpstreamRegistry.create(ids.map(entry), factories, fakeLogger());
}

function modelEntry(alias: string, routes: ModelConfig["routes"], strategy?: ModelConfig["balance"]["strategy"]): ModelConfig {
  return {
    alias,
    routes,
    balance: { strategy: strategy ?? (routes.some((route) => route.weight !== undefined) ? "weighted-round-robin" : "round-robin") },
  };
}

/** Controllable clock for deterministic cooldown transitions. */
function fakeClock() {
  let nowMs = 1_000_000;
  return {
    now: () => nowMs,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("isPreFirstByteFailure — the failure classification", () => {
  test("synthesized envelopes, relayed 5xx, and 429 fail the route", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(isPreFirstByteFailure(new Response(null, { status }))).toBe(true);
    }
  });

  test("a client-caused 4xx and a servable 2xx do not", () => {
    for (const status of [200, 201, 400, 401, 403, 404, 408, 422]) {
      expect(isPreFirstByteFailure(new Response(null, { status }))).toBe(false);
    }
  });
});

describe("createRouteBalancer — strategies", () => {
  test("round-robin rotates routes in config order, then repeats", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("dual", [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
      registry,
    );
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(balancer.select("dual")?.upstreamModel ?? "null");
    }
    expect(seen).toEqual(["m-alpha", "m-bravo", "m-alpha", "m-bravo", "m-alpha"]);
  });

  test("weighted round-robin repeats each route proportionally to its weight over a cycle", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [
        modelEntry("weighted", [
          { upstream: "alpha", model: "m-alpha", weight: 2 },
          { upstream: "bravo", model: "m-bravo", weight: 1 },
        ]),
      ],
      registry,
    );
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      seen.push(balancer.select("weighted")?.upstreamModel ?? "null");
    }
    expect(seen).toEqual(["m-alpha", "m-alpha", "m-bravo", "m-alpha", "m-alpha", "m-bravo"]);
  });

  test("an absent weight defaults to 1", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [
        modelEntry("weighted", [
          { upstream: "alpha", model: "m-alpha", weight: 2 },
          { upstream: "bravo", model: "m-bravo" },
        ]),
      ],
      registry,
    );
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      seen.push(balancer.select("weighted")?.upstreamModel ?? "null");
    }
    expect(seen).toEqual(["m-alpha", "m-alpha", "m-bravo"]);
  });

  test("weighted copies of one route share a single health state — all copies skip together", async () => {
    const clock = fakeClock();
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [
        modelEntry("weighted", [
          { upstream: "alpha", model: "m-alpha", weight: 2 },
          { upstream: "bravo", model: "m-bravo", weight: 1 },
        ]),
      ],
      registry,
      { now: clock.now, failureThreshold: 1, cooldownMs: 100 },
    );
    const first = balancer.select("weighted") as RouteSelection; // alpha copy 1
    expect(first.upstreamModel).toBe("m-alpha");
    balancer.report(first, false); // alpha opens (threshold 1) — both of its copies skip
    expect(balancer.select("weighted")?.upstreamModel).toBe("m-bravo");
    const second = balancer.select("weighted") as RouteSelection; // the cycle restarts at bravo
    expect(second.upstreamModel).toBe("m-bravo");
    balancer.report(second, false); // bravo opens too — nothing eligible
    expect(balancer.select("weighted")).toBeNull();
  });

  test("per-alias rotation state is independent", async () => {
    const registry = await registryWith("alpha", "bravo");
    const routes: ModelConfig["routes"] = [
      { upstream: "alpha", model: "m-alpha" },
      { upstream: "bravo", model: "m-bravo" },
    ];
    const balancer = createRouteBalancer([modelEntry("one", routes), modelEntry("two", routes)], registry);
    balancer.select("one"); // advances only "one"
    expect(balancer.select("two")?.upstreamModel).toBe("m-alpha");
    expect(balancer.select("one")?.upstreamModel).toBe("m-bravo");
  });
});

describe("createRouteBalancer — usable routes", () => {
  test("routesOf lists the usable routes in config order; unknown alias and ghost-only alias are null", async () => {
    const registry = await registryWith("alpha");
    const balancer = createRouteBalancer(
      [
        modelEntry("usable", [
          { upstream: "alpha", model: "m1" },
          { upstream: "ghost", model: "m2" },
        ]),
        modelEntry("unusable", [{ upstream: "ghost", model: "m3" }]),
      ],
      registry,
    );
    const usable = balancer.routesOf("usable") as ModelRouteConfig[];
    expect(usable.map((route) => route.model)).toEqual(["m1"]);
    expect(balancer.routesOf("unusable")).toBeNull();
    expect(balancer.routesOf("nope")).toBeNull();
  });

  test("a selection carries the registry upstream and the route's model", async () => {
    const registry = await registryWith("alpha");
    const balancer = createRouteBalancer([modelEntry("a", [{ upstream: "alpha", model: "m1" }])], registry);
    const selection = balancer.select("a");
    expect(selection?.upstream.id).toBe("alpha");
    expect(selection?.upstreamModel).toBe("m1");
    expect(selection?.routeId).toBe("a|alpha|m1");
  });
});

describe("createRouteBalancer — health", () => {
  test("a failure below the threshold keeps the route eligible; the tried-set excludes it for the request", async () => {
    const clock = fakeClock();
    const registry = await registryWith("alpha");
    const balancer = createRouteBalancer(
      [modelEntry("solo", [{ upstream: "alpha", model: "m1" }])],
      registry,
      { now: clock.now, failureThreshold: 2, cooldownMs: 100 },
    );
    const selection = balancer.select("solo");
    balancer.report(selection as RouteSelection, false);
    expect(balancer.select("solo")).not.toBeNull(); // future requests may retry
    expect(balancer.select("solo", new Set([selection?.routeId ?? ""]))).toBeNull(); // this request is done with it
  });

  test("threshold consecutive failures open the route — selection skips it for the cooldown", async () => {
    const clock = fakeClock();
    const registry = await registryWith("alpha");
    const balancer = createRouteBalancer(
      [modelEntry("solo", [{ upstream: "alpha", model: "m1" }])],
      registry,
      { now: clock.now, failureThreshold: 2, cooldownMs: 100 },
    );
    const first = balancer.select("solo") as RouteSelection;
    balancer.report(first, false);
    const second = balancer.select("solo") as RouteSelection;
    expect(second.routeId).toBe(first.routeId);
    balancer.report(second, false); // threshold reached — route opens

    clock.advance(50); // still inside the cooldown
    expect(balancer.select("solo")).toBeNull();
    expect(balancer.select("solo", new Set<string>())).toBeNull();

    clock.advance(ROUTE_COOLDOWN_MS); // way past the cooldown
    expect(balancer.select("solo")).not.toBeNull(); // half-open probe allowed
  });

  test("an unhealthy route is skipped while its siblings serve (skip, not failover-after-attempt)", async () => {
    const clock = fakeClock();
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("dual", [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
      registry,
      { now: clock.now, failureThreshold: 1, cooldownMs: 100 },
    );
    const first = balancer.select("dual") as RouteSelection;
    expect(first.upstream.id).toBe("alpha");
    balancer.report(first, false); // alpha opens immediately
    const second = balancer.select("dual") as RouteSelection;
    expect(second.upstream.id).toBe("bravo"); // alpha skipped without an attempt
    balancer.report(second, false); // bravo opens too — everything down
    expect(balancer.select("dual")).toBeNull();
  });

  test("cooldown expiry yields exactly one half-open probe: success closes, failure re-opens", async () => {
    const clock = fakeClock();
    const registry = await registryWith("alpha");
    const balancer = createRouteBalancer(
      [modelEntry("solo", [{ upstream: "alpha", model: "m1" }])],
      registry,
      { now: clock.now, failureThreshold: 1, cooldownMs: 100 },
    );

    // open the route
    balancer.report(balancer.select("solo") as RouteSelection, false);
    expect(balancer.select("solo")).toBeNull();

    clock.advance(100); // cooldown expired
    const probe = balancer.select("solo") as RouteSelection;
    expect(probe).not.toBeNull();
    // the single probe occupies the route: no concurrent attempt
    expect(balancer.select("solo")).toBeNull();
    balancer.report(probe, true); // probe succeeded — route closed
    expect(balancer.select("solo")).not.toBeNull();
  });

  test("a failed half-open probe re-opens the route for a fresh cooldown", async () => {
    const clock = fakeClock();
    const registry = await registryWith("alpha");
    const balancer = createRouteBalancer(
      [modelEntry("solo", [{ upstream: "alpha", model: "m1" }])],
      registry,
      { now: clock.now, failureThreshold: 1, cooldownMs: 100 },
    );
    balancer.report(balancer.select("solo") as RouteSelection, false);
    clock.advance(100);
    const probe = balancer.select("solo") as RouteSelection;
    expect(probe).not.toBeNull();
    balancer.report(probe, false); // probe failed — re-open

    clock.advance(50); // inside the fresh cooldown
    expect(balancer.select("solo")).toBeNull();
    clock.advance(60); // fresh cooldown expired
    expect(balancer.select("solo")).not.toBeNull(); // next probe
  });

  test("a success resets the consecutive-failure count", async () => {
    const clock = fakeClock();
    const registry = await registryWith("alpha");
    const balancer = createRouteBalancer(
      [modelEntry("solo", [{ upstream: "alpha", model: "m1" }])],
      registry,
      { now: clock.now, failureThreshold: 2, cooldownMs: 100 },
    );
    const first = balancer.select("solo") as RouteSelection;
    balancer.report(first, false);
    balancer.report(first, true); // resets the count to 0
    const second = balancer.select("solo") as RouteSelection;
    balancer.report(second, false); // failures back to 1 — below the threshold
    expect(balancer.select("solo")).not.toBeNull(); // still eligible
  });

  test("a client-caused 4xx counts as success for the route's health", async () => {
    const clock = fakeClock();
    const registry = await registryWith("alpha");
    const balancer = createRouteBalancer(
      [modelEntry("solo", [{ upstream: "alpha", model: "m1" }])],
      registry,
      { now: clock.now, failureThreshold: 1, cooldownMs: 100 },
    );
    const selection = balancer.select("solo") as RouteSelection;
    balancer.report(selection, true);
    expect(balancer.select("solo")).not.toBeNull();
  });

  test("defaults: the exported constants are the unpinned thresholds", async () => {
    const clock = fakeClock();
    const registry = await registryWith("alpha");
    const balancer = createRouteBalancer([modelEntry("solo", [{ upstream: "alpha", model: "m1" }])], registry, {
      now: clock.now,
    });
    for (let i = 0; i < ROUTE_FAILURE_THRESHOLD; i++) {
      balancer.report(balancer.select("solo") as RouteSelection, false);
    }
    expect(balancer.select("solo")).toBeNull(); // open
    clock.advance(ROUTE_COOLDOWN_MS - 1);
    expect(balancer.select("solo")).toBeNull(); // still cooling down
    clock.advance(1);
    expect(balancer.select("solo")).not.toBeNull(); // half-open probe
  });
});

describe("createRouteBalancer — session affinity (ADR-010)", () => {
  test("a keyed request sticks to its bound route across requests; another key and keyless requests follow the schedule", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("dual", [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
      registry,
    );
    const first = balancer.select("dual", undefined, "k1") as RouteSelection;
    expect(first.upstream.id).toBe("alpha"); // no binding yet: the schedule decides
    balancer.report(first, true, "k1"); // bound k1 → alpha
    const second = balancer.select("dual", undefined, "k2") as RouteSelection;
    expect(second.upstream.id).toBe("bravo"); // k2 is unbound: pure rotation
    balancer.report(second, true, "k2"); // bound k2 → bravo

    expect((balancer.select("dual", undefined, "k1") as RouteSelection).upstream.id).toBe("alpha");
    expect((balancer.select("dual", undefined, "k2") as RouteSelection).upstream.id).toBe("bravo");
    expect((balancer.select("dual") as RouteSelection).upstream.id).toBe("alpha"); // keyless keeps rotating
    expect((balancer.select("dual", undefined, "k1") as RouteSelection).upstream.id).toBe("alpha"); // still stuck
  });

  test("a pre-first-byte failure on the bound route releases the binding — the key migrates with failover", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("dual", [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
      registry,
    );
    balancer.report(balancer.select("dual", undefined, "k1") as RouteSelection, true, "k1"); // k1 → alpha
    expect((balancer.select("dual", undefined, "k1") as RouteSelection).upstream.id).toBe("alpha");

    // the bound route fails before its first byte: the binding is released …
    balancer.report(balancer.select("dual", undefined, "k1") as RouteSelection, false, "k1");
    // … and the failover attempt (alpha already tried in this request) lands on bravo,
    // whose success re-binds the key there.
    const moved = balancer.select("dual", new Set(["dual|alpha|m-alpha"]), "k1") as RouteSelection;
    expect(moved.upstream.id).toBe("bravo");
    balancer.report(moved, true, "k1");
    expect((balancer.select("dual", undefined, "k1") as RouteSelection).upstream.id).toBe("bravo");
  });

  test("a bound route made ineligible by health is skipped for the request; the binding survives until a success re-binds", async () => {
    const clock = fakeClock();
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("dual", [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
      registry,
      { now: clock.now, failureThreshold: 1, cooldownMs: 100 },
    );
    balancer.report(balancer.select("dual", undefined, "k1") as RouteSelection, true, "k1"); // k1 → alpha
    balancer.report(balancer.select("dual") as RouteSelection, true); // keyless rotation keeps everything healthy
    const alphaPick = balancer.select("dual") as RouteSelection; // keyless rotation reaches alpha
    expect(alphaPick.upstream.id).toBe("alpha");
    balancer.report(alphaPick, false, "kx"); // alpha opens via an unbound key — k1's binding is untouched

    // alpha is cooling down: the keyed request falls through to the schedule…
    expect((balancer.select("dual", undefined, "k1") as RouteSelection).upstream.id).toBe("bravo");
    // … no success reported, so the binding to alpha survives…
    clock.advance(100); // alpha's cooldown expires
    // … and the affinity pick returns to alpha — as the single half-open probe.
    const probe = balancer.select("dual", undefined, "k1") as RouteSelection;
    expect(probe.upstream.id).toBe("alpha");
    // the probe occupies the route: a concurrent keyed request takes the sibling
    expect((balancer.select("dual", undefined, "k1") as RouteSelection).upstream.id).toBe("bravo");
    balancer.report(probe, true, "k1"); // probe succeeded — closed, re-bound
    expect((balancer.select("dual", undefined, "k1") as RouteSelection).upstream.id).toBe("alpha");
  });

  test("without a key, selection is the pure schedule choice even while other keys are bound", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("dual", [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
      registry,
    );
    balancer.report(balancer.select("dual", undefined, "k1") as RouteSelection, true, "k1");
    expect((balancer.select("dual") as RouteSelection).upstream.id).toBe("bravo");
    expect((balancer.select("dual") as RouteSelection).upstream.id).toBe("alpha");
    expect((balancer.select("dual") as RouteSelection).upstream.id).toBe("bravo");
  });

  test("keys are scoped per alias — the same key binds independently in each", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("one", [{ upstream: "alpha", model: "m-alpha" }]), modelEntry("two", [{ upstream: "bravo", model: "m-bravo" }])],
      registry,
    );
    balancer.report(balancer.select("one", undefined, "k") as RouteSelection, true, "k"); // (one, k) → alpha
    expect((balancer.select("two", undefined, "k") as RouteSelection).upstream.id).toBe("bravo"); // two: own schedule
    expect((balancer.select("one", undefined, "k") as RouteSelection).upstream.id).toBe("alpha");
  });

  test("an empty key is no key: it neither reads nor writes a binding", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("dual", [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
      registry,
    );
    balancer.report(balancer.select("dual", undefined, "") as RouteSelection, true, "");
    expect((balancer.select("dual", undefined, "") as RouteSelection).upstream.id).toBe("bravo"); // rotated, not stuck
  });

  test("affinityMaxEntries 0 disables binding entirely", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("dual", [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
      registry,
      { affinityMaxEntries: 0 },
    );
    balancer.report(balancer.select("dual", undefined, "k1") as RouteSelection, true, "k1");
    expect((balancer.select("dual", undefined, "k1") as RouteSelection).upstream.id).toBe("bravo"); // pure rotation
  });

  test("the map is LRU-bounded: inserting past affinityMaxEntries evicts the least-recently-used key", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("dual", [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
      registry,
      { affinityMaxEntries: 2 },
    );
    balancer.report(balancer.select("dual", undefined, "k1") as RouteSelection, true, "k1"); // [k1]
    balancer.report(balancer.select("dual", undefined, "k2") as RouteSelection, true, "k2"); // [k1, k2]
    balancer.report(balancer.select("dual", undefined, "k3") as RouteSelection, true, "k3"); // [k2, k3] — k1 evicted
    expect((balancer.select("dual", undefined, "k1") as RouteSelection).upstream.id).toBe("bravo"); // unbound: schedule
    expect((balancer.select("dual", undefined, "k3") as RouteSelection).upstream.id).toBe("alpha"); // retained
    expect((balancer.select("dual", undefined, "k2") as RouteSelection).upstream.id).toBe("bravo"); // retained
  });

  test("a served hit refreshes recency — the touched key survives while an untouched one is evicted", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("dual", [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
      registry,
      { affinityMaxEntries: 2 },
    );
    balancer.report(balancer.select("dual", undefined, "k1") as RouteSelection, true, "k1"); // [k1]
    balancer.report(balancer.select("dual", undefined, "k2") as RouteSelection, true, "k2"); // [k1, k2]
    expect((balancer.select("dual", undefined, "k1") as RouteSelection).upstream.id).toBe("alpha"); // hit: [k2, k1]
    balancer.report(balancer.select("dual", undefined, "k3") as RouteSelection, true, "k3"); // evicts k2 → [k1, k3]
    expect((balancer.select("dual", undefined, "k2") as RouteSelection).upstream.id).toBe("alpha"); // evicted: schedule
    expect((balancer.select("dual", undefined, "k1") as RouteSelection).upstream.id).toBe("alpha"); // survived
    expect((balancer.select("dual", undefined, "k3") as RouteSelection).upstream.id).toBe("bravo"); // survived (bound to bravo)
  });

  test("defaults: the exported constant is the unpinned bound", async () => {
    const registry = await registryWith("alpha", "bravo");
    const balancer = createRouteBalancer(
      [modelEntry("dual", [{ upstream: "alpha", model: "m-alpha" }, { upstream: "bravo", model: "m-bravo" }])],
      registry,
    );
    for (let i = 0; i <= AFFINITY_MAX_ENTRIES; i++) {
      balancer.report(balancer.select("dual", undefined, `k${i}`) as RouteSelection, true, `k${i}`);
    }
    // the very first key was evicted by the (N+1)-th insert…
    expect((balancer.select("dual", undefined, "k0") as RouteSelection).upstream.id).toBe("bravo");
    // … while the newest key is still stuck.
    expect((balancer.select("dual", undefined, `k${AFFINITY_MAX_ENTRIES}`) as RouteSelection).upstream.id).toBe("alpha");
  });
});
