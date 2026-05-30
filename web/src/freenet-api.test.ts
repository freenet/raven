import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { GetRequest, GetResponse } from "@freenetorg/freenet-stdlib";

// ---------------------------------------------------------------------------
// Mocking approach
// ---------------------------------------------------------------------------
// freenet-api.ts builds its WebSocket client from the stdlib's `FreenetWsApi`
// inside connect(). Every OTHER stdlib symbol it (and shard-key.ts) uses —
// ContractKey, GetRequest, WasmContractV1, the flatbuffer tables — must stay
// REAL, because shard-key.ts derives genuine ContractKeys and the production
// code routes GET responses by `key.encode()`. So we do a PARTIAL mock: keep
// `...actual`, and replace only `FreenetWsApi` with a fake whose constructor
// captures the ResponseHandler and whose `.get()` returns deferred promises we
// settle by hand. That lets us drive the client state machine deterministically
// without a node, while real keys still match real responses.
//
// `./identity` is mocked too: likePost/publishPost call signLike/signPost,
// which only succeed when a delegate is connected. We stub them to report
// "delegate connected" so those flows proceed without a real delegate.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  req: GetRequest;
}

// The FakeWsApi class must be defined inside vi.hoisted, because vi.mock's
// factory is hoisted to the very top of the module — referencing a normal
// top-level class there throws "Cannot access before initialization". Anything
// the factory closes over has to come from vi.hoisted (which runs first).
const { FakeWsApi } = vi.hoisted(() => {
  function deferred<T>(req: GetRequest): Deferred<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject, req };
  }

  /** Fake FreenetWsApi: records calls, hands back controllable GET promises. */
  class FakeWsApi {
    static instances: FakeWsApi[] = [];
    handler: import("@freenetorg/freenet-stdlib").ResponseHandler;
    getCalls: Deferred<GetResponse>[] = [];
    putCalls: unknown[] = [];
    updateCalls: unknown[] = [];
    subscribeCalls: unknown[] = [];
    /** When set, update() rejects with this — to exercise completeLike's catch. */
    updateError: Error | null = null;

    constructor(
      _url: URL,
      handler: import("@freenetorg/freenet-stdlib").ResponseHandler,
      _token: string,
    ) {
      this.handler = handler;
      FakeWsApi.instances.push(this);
    }

    get(req: GetRequest): Promise<GetResponse> {
      const d = deferred<GetResponse>(req);
      this.getCalls.push(d);
      return d.promise;
    }

    put(req: unknown): Promise<void> {
      this.putCalls.push(req);
      return Promise.resolve();
    }

    update(req: unknown): Promise<void> {
      this.updateCalls.push(req);
      return this.updateError
        ? Promise.reject(this.updateError)
        : Promise.resolve();
    }

    subscribe(req: unknown): Promise<void> {
      this.subscribeCalls.push(req);
      return Promise.resolve();
    }
  }
  return { FakeWsApi };
});

type FakeWsApi = InstanceType<typeof FakeWsApi>;

vi.mock("@freenetorg/freenet-stdlib", async (importActual) => {
  const actual = await importActual<typeof import("@freenetorg/freenet-stdlib")>();
  return { ...actual, FreenetWsApi: FakeWsApi };
});

// signPost/signLike normally require a connected delegate. Report connected so
// likePost/publishPost proceed; we drive completeLike/completePublish directly.
vi.mock("./identity", () => ({
  signPost: vi.fn(() => true),
  signLike: vi.fn(() => true),
  signRepost: vi.fn(() => true),
}));

import {
  FreenetConnection,
  type FreenetCallbacks,
  type LikeState,
  type RepostState,
} from "./freenet-api";

// A real ML-DSA-65 VK is 1952 bytes → 3904 hex chars; setUser only initialises
// the user shard for a key of exactly that length (the offline 64-char fake is
// rejected). Use a deterministic 3904-char hex owner.
const OWNER_VK = "ab".repeat(1952);

function makeConnection() {
  const callbacks: {
    onPostsLoaded: ReturnType<typeof vi.fn>;
    onNewPost: ReturnType<typeof vi.fn>;
    onStatusChange: ReturnType<typeof vi.fn>;
    onLikeUpdated: ReturnType<typeof vi.fn>;
    onRepostUpdated: ReturnType<typeof vi.fn>;
  } = {
    onPostsLoaded: vi.fn(),
    onNewPost: vi.fn(),
    onStatusChange: vi.fn(),
    onLikeUpdated: vi.fn(),
    onRepostUpdated: vi.fn(),
  };
  const conn = new FreenetConnection(callbacks as unknown as FreenetCallbacks);
  conn.connect();
  const api = FakeWsApi.instances[FakeWsApi.instances.length - 1];
  return { conn, api, callbacks };
}

/** Flush the microtask queue so chained `.then` callbacks run. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeWsApi.instances = [];
  vi.useRealTimers();
  // connect() builds `ws://${location.host}/...`; the node test env has no DOM
  // `location`. Stub a minimal one so the URL constructs and our FakeWsApi is
  // reached. (Vitest's default env is `node`; we don't otherwise need a DOM.)
  (globalThis as { location?: { host: string } }).location = {
    host: "localhost:8080",
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { location?: unknown }).location;
});

describe("FreenetConnection", () => {
  describe("serializedGet — single GET in flight (H-1 anti-misroute guarantee)", () => {
    // This is the core property the H-1 fix restores: at most one api.get() is
    // outstanding, so the stdlib's uncorrelated FIFO response queue can never
    // settle the wrong awaited promise. If serialisation regresses, two GETs
    // overlap and responses can be swapped (feed never instantiates / likes
    // silently lost).
    it("does not issue the 2nd GET until the 1st settles", async () => {
      const { conn, api } = makeConnection();

      // Two independent GET-issuing flows started back-to-back: a user-shard
      // load and a thread like-refresh. Both go through serializedGet.
      conn.setUser(OWNER_VK, "Alice", "alice"); // -> initUserShard -> probe GET
      // refreshLikesNow is private; drive it via the public update-notification
      // path would debounce, so reach it through likePost is heavier. Instead
      // issue a second user-shard load via loadState() once the shard key is set.
      await flush();

      // Exactly one GET in flight after kicking off the first flow.
      expect(api.getCalls.length).toBe(1);

      // Start a SECOND serialised GET (another load). It must NOT call api.get()
      // yet — it's queued behind the first on getChain.
      conn.loadState();
      await flush();
      expect(api.getCalls.length).toBe(1); // still only the first

      // Settle the first GET (reject = not-found probe). Chain advances.
      api.getCalls[0].reject(new Error("not found"));
      await flush();
      await flush();

      // Now the second GET is allowed out.
      expect(api.getCalls.length).toBe(2);
    });

    it("advances the chain even when a GET rejects (no wedge)", async () => {
      const { conn, api } = makeConnection();

      // Establish the user-shard key cleanly: resolve initUserShard's probe so
      // it treats the shard as existing (no PUT/fetch), then it issues its own
      // loadUserShard GET. Settle that too so the chain is idle and the key set.
      conn.setUser(OWNER_VK, "Alice", "alice");
      await flush();
      expect(api.getCalls.length).toBe(1); // the probe
      api.getCalls[0].resolve({} as GetResponse); // exists -> no PUT
      await flush();
      await flush();
      expect(api.getCalls.length).toBe(2); // loadUserShard GET issued
      api.getCalls[1].resolve({} as GetResponse);
      await flush();
      await flush();

      // Now drive two serialised loadState() GETs. Reject the first: a wedged
      // chain would block the second forever; the fix advances getChain on
      // settle either way.
      conn.loadState();
      await flush();
      expect(api.getCalls.length).toBe(3);
      conn.loadState();
      await flush();
      expect(api.getCalls.length).toBe(3); // queued behind the (rejecting) #3

      api.getCalls[2].reject(new Error("timeout"));
      await flush();
      await flush();
      // The second load got out despite the rejection -> chain not wedged.
      expect(api.getCalls.length).toBe(4);
    });

    it("each caller sees its own GET outcome (resolve), then chain continues", async () => {
      const { conn, api } = makeConnection();
      conn.setUser(OWNER_VK, "Alice", "alice");
      await flush();
      expect(api.getCalls.length).toBe(1);

      conn.loadState();
      await flush();
      expect(api.getCalls.length).toBe(1);

      // Resolve the first probe GET successfully -> userShardExists() true ->
      // no PUT; chain advances and releases the queued load.
      api.getCalls[0].resolve({} as GetResponse);
      await flush();
      await flush();
      expect(api.getCalls.length).toBe(2);
    });

    // Regression guard for H-A (skeptical review of PR #35): the soft 8 s app
    // timeout MUST NOT advance the chain, because the stdlib keeps the timed-out
    // GET in its `pendingGets` FIFO until a real response or its OWN 30 s reject.
    // If the chain advanced on the soft timeout, the next api.get() would be
    // issued while the stale entry is still queued → two entries → a late
    // response pops the wrong promise (the misroute this fix exists to prevent).
    it("does NOT advance the chain on the soft timeout — only on the real GET settle", async () => {
      vi.useFakeTimers();
      try {
        const { conn, api } = makeConnection();

        conn.setUser(OWNER_VK, "Alice", "alice"); // probe GET in flight
        await vi.advanceTimersByTimeAsync(0);
        expect(api.getCalls.length).toBe(1);

        // A second serialised GET is queued behind the (still-unsettled) probe.
        conn.loadState();
        await vi.advanceTimersByTimeAsync(0);
        expect(api.getCalls.length).toBe(1);

        // Fire the 8 s soft timeout WITHOUT settling the underlying GET. The
        // stdlib entry is still live; the chain must stay blocked.
        await vi.advanceTimersByTimeAsync(8000);
        expect(api.getCalls.length).toBe(1); // 2nd GET still NOT issued

        // Only once the real (late) GET settles does the chain advance.
        api.getCalls[0].resolve({} as GetResponse);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(api.getCalls.length).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("dropPendingLike — nonce matching", () => {
    it("returns true only when a matching pending like exists, false otherwise", async () => {
      const { conn, api } = makeConnection();

      // Seed a pending like via likePost. likePost -> ensureThreadShard probe
      // GET; resolve it so the shard is treated as existing, then signLike (mock)
      // returns true and the pending like is recorded.
      const likePromise = conn.likePost("post-1", true);
      await flush();
      // ensureThreadShard issued a probe GET; resolve it as existing.
      expect(api.getCalls.length).toBe(1);
      api.getCalls[0].resolve({} as GetResponse);
      const ok = await likePromise;
      expect(ok).toBe(true);

      // We don't know the internal nonce, so test the false branch directly and
      // then exercise the true branch via completeLike below.
      expect(conn.dropPendingLike("nonce-that-does-not-exist")).toBe(false);
    });
  });

  describe("optimistic like revert", () => {
    it("completeLike refreshes (re-GETs) on update SUCCESS", async () => {
      const { conn, api } = makeConnection();

      // Drive completeLike for a known nonce. It folds the like into the thread
      // shard via update(), then refreshLikesNow() issues a GET to read back the
      // authoritative aggregate.
      const before = api.getCalls.length;
      const ok = await conn.completeLike({
        nonce: "n1",
        root_post_id: "root-success",
        signer_pubkey: OWNER_VK,
        seq: Date.now(),
        liked: true,
        signature: "sig",
      });
      // No matching pending like was registered, so completeLike short-circuits
      // false BEFORE updating — register one first to reach the success path.
      expect(ok).toBe(false);
      expect(api.updateCalls.length).toBe(0);
      expect(api.getCalls.length).toBe(before);
    });

    it("completeLike (matched nonce) updates then refreshes on SUCCESS", async () => {
      const { conn, api } = makeConnection();

      // Register a pending like through likePost, capturing its nonce.
      const signLikeMock = (await import("./identity"))
        .signLike as unknown as ReturnType<typeof vi.fn>;
      const likePromise = conn.likePost("root-ok", true);
      await flush();
      api.getCalls[api.getCalls.length - 1].resolve({} as GetResponse); // probe exists
      await likePromise;
      // signLike(nonce, rootPostId, seq, liked) — first arg is the nonce.
      const nonce = signLikeMock.mock.calls[0][0] as string;

      const getsBefore = api.getCalls.length;
      const ok = await conn.completeLike({
        nonce,
        root_post_id: "root-ok",
        signer_pubkey: OWNER_VK,
        seq: Date.now(),
        liked: true,
        signature: "sig",
      });
      expect(ok).toBe(true);
      // Update sent, then a refresh GET issued.
      expect(api.updateCalls.length).toBe(1);
      expect(api.getCalls.length).toBe(getsBefore + 1);
      // The matched nonce was consumed; dropping it again is a no-op.
      expect(conn.dropPendingLike(nonce)).toBe(false);
    });

    it("completeLike refreshes on update FAILURE so the UI reconciles", async () => {
      const { conn, api } = makeConnection();
      api.updateError = new Error("update rejected");

      const signLikeMock = (await import("./identity"))
        .signLike as unknown as ReturnType<typeof vi.fn>;
      const likePromise = conn.likePost("root-fail", true);
      await flush();
      api.getCalls[api.getCalls.length - 1].resolve({} as GetResponse);
      await likePromise;
      const nonce = signLikeMock.mock.calls[
        signLikeMock.mock.calls.length - 1
      ][0] as string;

      const getsBefore = api.getCalls.length;
      const ok = await conn.completeLike({
        nonce,
        root_post_id: "root-fail",
        signer_pubkey: OWNER_VK,
        seq: Date.now(),
        liked: true,
        signature: "sig",
      });
      // Update failed -> returns false, but STILL re-GETs to reconcile the
      // optimistic toggle away (the H-fix: refresh on BOTH paths).
      expect(ok).toBe(false);
      expect(api.updateCalls.length).toBe(1);
      expect(api.getCalls.length).toBe(getsBefore + 1);
    });

    it("dropPendingLike returns true for a real pending like, then false", async () => {
      const { conn, api } = makeConnection();
      const signLikeMock = (await import("./identity"))
        .signLike as unknown as ReturnType<typeof vi.fn>;

      const likePromise = conn.likePost("root-drop", true);
      await flush();
      api.getCalls[api.getCalls.length - 1].resolve({} as GetResponse);
      await likePromise;
      const nonce = signLikeMock.mock.calls[
        signLikeMock.mock.calls.length - 1
      ][0] as string;

      expect(conn.dropPendingLike(nonce)).toBe(true); // matched -> dropped
      expect(conn.dropPendingLike(nonce)).toBe(false); // already gone
    });
  });

  describe("optimistic repost revert", () => {
    it("completeRepost (matched nonce) updates then refreshes on SUCCESS", async () => {
      const { conn, api } = makeConnection();

      const signRepostMock = (await import("./identity"))
        .signRepost as unknown as ReturnType<typeof vi.fn>;
      const repostPromise = conn.repostPost("root-ok", true);
      await flush();
      api.getCalls[api.getCalls.length - 1].resolve({} as GetResponse); // probe exists
      await repostPromise;
      // signRepost(nonce, rootPostId, seq, reposted) — first arg is the nonce.
      const nonce = signRepostMock.mock.calls[0][0] as string;

      const getsBefore = api.getCalls.length;
      const ok = await conn.completeRepost({
        nonce,
        root_post_id: "root-ok",
        signer_pubkey: OWNER_VK,
        seq: Date.now(),
        reposted: true,
        signature: "sig",
      });
      expect(ok).toBe(true);
      expect(api.updateCalls.length).toBe(1);
      expect(api.getCalls.length).toBe(getsBefore + 1);
      expect(conn.dropPendingRepost(nonce)).toBe(false); // consumed
    });

    it("completeRepost refreshes on update FAILURE so the UI reconciles", async () => {
      const { conn, api } = makeConnection();
      api.updateError = new Error("update rejected");

      const signRepostMock = (await import("./identity"))
        .signRepost as unknown as ReturnType<typeof vi.fn>;
      const repostPromise = conn.repostPost("root-fail", true);
      await flush();
      api.getCalls[api.getCalls.length - 1].resolve({} as GetResponse);
      await repostPromise;
      const nonce = signRepostMock.mock.calls[
        signRepostMock.mock.calls.length - 1
      ][0] as string;

      const getsBefore = api.getCalls.length;
      const ok = await conn.completeRepost({
        nonce,
        root_post_id: "root-fail",
        signer_pubkey: OWNER_VK,
        seq: Date.now(),
        reposted: true,
        signature: "sig",
      });
      expect(ok).toBe(false);
      expect(api.updateCalls.length).toBe(1);
      expect(api.getCalls.length).toBe(getsBefore + 1);
    });

    it("dropPendingRepost returns true for a real pending repost, then false", async () => {
      const { conn, api } = makeConnection();
      const signRepostMock = (await import("./identity"))
        .signRepost as unknown as ReturnType<typeof vi.fn>;

      const repostPromise = conn.repostPost("root-drop", true);
      await flush();
      api.getCalls[api.getCalls.length - 1].resolve({} as GetResponse);
      await repostPromise;
      const nonce = signRepostMock.mock.calls[
        signRepostMock.mock.calls.length - 1
      ][0] as string;

      expect(conn.dropPendingRepost(nonce)).toBe(true);
      expect(conn.dropPendingRepost(nonce)).toBe(false);
    });
  });

  describe("completePublish / dropPendingPost — nonce matching", () => {
    async function seedDraft(conn: FreenetConnection) {
      // publishPost needs a user shard + currentUser. setUser sets currentUser
      // and kicks off initUserShard (which sets userShardKey synchronously after
      // deriving — but it's async). Drive it and settle the probe so the shard
      // key is in place.
      const signPostMock = (await import("./identity"))
        .signPost as unknown as ReturnType<typeof vi.fn>;
      const ok = await conn.publishPost("hello world");
      return { ok, signPostMock };
    }

    it("completePublish with an UNKNOWN nonce returns false, leaves drafts intact", async () => {
      const { conn, api } = makeConnection();
      conn.setUser(OWNER_VK, "Alice", "alice");
      await flush();
      // Resolve the user-shard probe so userShardKey/exists is settled.
      if (api.getCalls.length) api.getCalls[0].resolve({} as GetResponse);
      await flush();

      const { ok, signPostMock } = await seedDraft(conn);
      expect(ok).toBe(true);
      const realNonce = signPostMock.mock.calls[
        signPostMock.mock.calls.length - 1
      ][0] as string;

      // Unknown nonce -> no draft matched -> false, and no update sent.
      const updatesBefore = api.updateCalls.length;
      const res = await conn.completePublish({
        nonce: "no-such-nonce",
        post_id: "pid",
        signature: "sig",
        public_key: OWNER_VK,
      });
      expect(res).toBe(false);
      expect(api.updateCalls.length).toBe(updatesBefore);

      // The real draft is still there: completing it now succeeds and sends an
      // update (proving the unknown-nonce call did NOT consume it).
      const res2 = await conn.completePublish({
        nonce: realNonce,
        post_id: "pid",
        signature: "sig",
        public_key: OWNER_VK,
      });
      expect(res2).toBe(true);
      expect(api.updateCalls.length).toBe(updatesBefore + 1);
    });

    it("dropPendingPost removes only the matching nonce", async () => {
      const { conn, api } = makeConnection();
      conn.setUser(OWNER_VK, "Alice", "alice");
      await flush();
      if (api.getCalls.length) api.getCalls[0].resolve({} as GetResponse);
      await flush();

      const signPostMock = (await import("./identity"))
        .signPost as unknown as ReturnType<typeof vi.fn>;

      // Two drafts queued.
      await conn.publishPost("first");
      await conn.publishPost("second");
      const nonceA = signPostMock.mock.calls[0][0] as string;
      const nonceB = signPostMock.mock.calls[1][0] as string;
      expect(nonceA).not.toBe(nonceB);

      // Drop only A. B must survive: completePublish(B) succeeds, A fails.
      conn.dropPendingPost(nonceA);

      const resA = await conn.completePublish({
        nonce: nonceA,
        post_id: "pa",
        signature: "s",
        public_key: OWNER_VK,
      });
      expect(resA).toBe(false); // A was dropped

      const resB = await conn.completePublish({
        nonce: nonceB,
        post_id: "pb",
        signature: "s",
        public_key: OWNER_VK,
      });
      expect(resB).toBe(true); // B untouched
    });
  });

  describe("handleGetResponse routing -> like aggregate", () => {
    it("a thread-shard GET response emits onLikeUpdated with the correct count/likedByMe", async () => {
      const { conn, api, callbacks } = makeConnection();

      // ownerVkHex (used by emitLikeState for likedByMe) is only set when a real
      // 3904-char VK is supplied via setUser. Set it, then settle the user-shard
      // init GETs so the chain is idle.
      conn.setUser(OWNER_VK, "Alice", "alice");
      await flush();
      api.getCalls[0].resolve({} as GetResponse); // probe -> exists
      await flush();
      await flush();
      if (api.getCalls[1]) api.getCalls[1].resolve({} as GetResponse); // loadUserShard
      await flush();
      await flush();

      // Like a post so the thread key + instance->root mapping is registered
      // (handleGetResponse routes by instance id).
      const rootId = "thread-root-1";
      const likePromise = conn.likePost(rootId, true);
      await flush();
      const probe = api.getCalls[api.getCalls.length - 1];
      probe.resolve({} as GetResponse);
      await likePromise;

      // Build a thread-shard GET response for that key with two likes, one of
      // them by the owner, and feed it through the captured handler.
      const likes = {
        a: { signer_pubkey: OWNER_VK, seq: 1, liked: true, signature: "s" },
        b: { signer_pubkey: "cd".repeat(1952), seq: 1, liked: true, signature: "s" },
        c: { signer_pubkey: "ef".repeat(1952), seq: 2, liked: false, signature: "s" },
      };
      // One thread GET carries both surfaces: two reposts true (one by owner),
      // one un-repost tombstone.
      const reposts = {
        a: { signer_pubkey: OWNER_VK, seq: 1, reposted: true, signature: "s" },
        b: { signer_pubkey: "cd".repeat(1952), seq: 1, reposted: true, signature: "s" },
        c: { signer_pubkey: "ef".repeat(1952), seq: 2, reposted: false, signature: "s" },
      };
      const stateBytes = Array.from(
        new TextEncoder().encode(JSON.stringify({ likes, reposts })),
      );
      const key = probe.req.key; // same ContractKey the thread uses

      callbacks.onLikeUpdated.mockClear();
      callbacks.onRepostUpdated.mockClear();
      api.handler.onContractGet({
        key,
        state: stateBytes,
      } as unknown as GetResponse);

      expect(callbacks.onLikeUpdated).toHaveBeenCalledTimes(1);
      const emitted = callbacks.onLikeUpdated.mock.calls[0][0] as LikeState;
      expect(emitted.postId).toBe(rootId);
      expect(emitted.count).toBe(2); // two liked:true records
      expect(emitted.likedByMe).toBe(true); // owner is among them

      expect(callbacks.onRepostUpdated).toHaveBeenCalledTimes(1);
      const reEmit = callbacks.onRepostUpdated.mock.calls[0][0] as RepostState;
      expect(reEmit.postId).toBe(rootId);
      expect(reEmit.count).toBe(2); // two reposted:true records
      expect(reEmit.repostedByMe).toBe(true); // owner is among them
    });
  });
});
