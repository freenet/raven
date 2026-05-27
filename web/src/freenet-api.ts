import {
  FreenetWsApi,
  ContractKey,
  ContractContainer,
  ContractType as WasmContractType,
  WasmContractV1,
  GetRequest,
  GetResponse,
  PutRequest,
  UpdateRequest,
  UpdateResponse,
  UpdateNotification,
  UpdateData,
  UpdateDataType,
  DeltaUpdate,
  SubscribeRequest,
  PutResponse,
  DelegateResponse,
  HostError,
  ResponseHandler,
} from "@freenetorg/freenet-stdlib";
// ContractCodeT is the constructable flatbuffer code table (with .pack()). It
// is not re-exported from the package root, only the /common subpath.
import { ContractCodeT } from "@freenetorg/freenet-stdlib/common";
import { Post } from "./types";
import { deriveShardContractKey, hexToBytes } from "./shard-key";
import { signPost, signLike } from "./identity";

// Contract post format (matches Rust `common::post::Post`). Signature and
// author_pubkey are hex strings (ML-DSA-65 sig 3309 B, VK 1952 B); the id is
// the content address (hex of blake3 over the canonical signing payload).
interface ContractPost {
  id: string;
  author_pubkey: string;
  author_name: string;
  author_handle: string;
  content: string;
  timestamp: number;
  signature: string | null;
}

interface PendingPostDraft {
  nonce: string;
  author_name: string;
  author_handle: string;
  content: string;
  timestamp: number;
}

// User-shard state (matches Rust `UserShard`). Only `posts` is consumed by the
// feed today; profile/follows are deserialized-tolerant (present-or-absent).
interface UserShardState {
  posts?: ContractPost[];
  profile?: unknown;
  follows?: Record<string, unknown>;
}

// A like record (matches Rust `common::thread::LikeRecord`). signer_pubkey is
// the liker's VK hex; `liked` true=like / false=unlike (tombstone); signature
// is over the canonical payload the delegate built.
interface LikeRecord {
  signer_pubkey: string;
  seq: number;
  liked: boolean;
  writer_cert?: unknown;
  signature: string | null;
}

// Thread-shard state (matches Rust `ThreadShard`). Only `likes` is consumed in
// this slice; replies/quotes land in later slices.
interface ThreadShardState {
  replies?: Record<string, ContractPost>;
  likes?: Record<string, LikeRecord>;
  quotes?: Record<string, unknown>;
}

/** A pending like awaiting the delegate's `SignedLike`, keyed by nonce. */
interface PendingLike {
  nonce: string;
  rootPostId: string;
  liked: boolean;
}

/** Aggregate like state for one post, derived from its thread shard. */
export interface LikeState {
  postId: string;
  count: number;
  likedByMe: boolean;
}

// Convert contract format → UI format
function contractPostToUiPost(cp: ContractPost): Post {
  return {
    id: cp.id,
    author: {
      displayName: cp.author_name,
      handle: cp.author_handle,
      avatarColor: stringToColor(cp.author_pubkey),
      publicKey: cp.author_pubkey,
    },
    content: cp.content,
    timestamp: new Date(cp.timestamp),
    likes: 0,
    reposts: 0,
    replies: 0,
    liked: false,
    reposted: false,
  };
}

// Deterministic color from string
function stringToColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 65%, 45%)`;
}

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface FreenetCallbacks {
  onPostsLoaded: (posts: Post[]) => void;
  onNewPost: (post: Post) => void;
  onStatusChange: (status: ConnectionStatus) => void;
  /** Optional: receives delegate responses forwarded from the node. */
  onDelegateResponse?: (response: DelegateResponse) => void;
  /** Optional: live like count / liked-by-me for a post, from its thread shard. */
  onLikeUpdated?: (like: LikeState) => void;
}

export class FreenetConnection {
  private api: FreenetWsApi | null = null;
  private callbacks: FreenetCallbacks;
  private currentUser: {
    pubkey: string;
    name: string;
    handle: string;
  } | null = null;
  /** Drafts awaiting a delegate `Signed` response, FIFO. See publishPost. */
  private pendingPosts: PendingPostDraft[] = [];
  /**
   * The owner's ML-DSA-65 verifying key (hex) once the delegate reports the
   * identity. Used to derive this owner's user-shard key. Null until known.
   */
  private ownerVkHex: string | null = null;
  /**
   * The per-owner user-shard contract key, derived from the owner VK and the
   * build-injected shard code hash (ADR-0001 Phase 4). Once set, the feed reads
   * and writes the user shard instead of the legacy global posts contract.
   */
  private userShardKey: ContractKey | null = null;
  /** Base58 instance id of {@link userShardKey}, for response key matching. */
  private userShardInstanceId: string | null = null;
  /** Guards against concurrent user-shard init for the SAME owner. Reset when
   * the owner VK changes (identity switch) so the new shard re-initialises. */
  private userShardInitOwner: string | null = null;
  /**
   * Serialises every `api.get()` so at most one GET is in flight at a time.
   *
   * The stdlib resolves GET promises from a single FIFO queue with NO request
   * correlation: the Nth `GetResponse`/`NotFound` to arrive settles the Nth
   * pending `get()` promise, regardless of which contract it was for. With
   * multiple concurrent shard flows live (user-shard probe/load, per-thread
   * probe/like-refresh) two in-flight GETs can have their responses swapped —
   * a thread GET resolving the user-shard probe (→ feed never instantiates) or
   * a like-refresh popping a thread probe (→ that thread never PUT, the like is
   * silently lost). Routing-by-key in `handleGetResponse` fixes WHICH handler
   * runs, but not WHICH awaited promise settles. The only robust fix without
   * stdlib request-ids is to never have two GETs outstanding: each `api.get()`
   * awaits the previous one's settle. (The prior `startupDone` barrier only
   * covered startup-time traffic, which #33 removed — it serialised nothing
   * against the real post-init concurrency.)
   */
  private getChain: Promise<unknown> = Promise.resolve();
  /**
   * Per-thread shard keys, lazily derived the first time a post is liked. Keyed
   * by root post id (the thread-shard parameter). A thread shard is parameterized
   * by its root post id, so its key = blake3(thread_code_hash || utf8(post_id)).
   */
  private threadKeys = new Map<string, ContractKey>();
  /** Reverse map: thread instance id (base58) → root post id, for GET routing. */
  private threadInstanceToRoot = new Map<string, string>();
  /** Likes awaiting a delegate `SignedLike`, keyed by nonce. */
  private pendingLikes: PendingLike[] = [];
  /** Per-thread debounce timers coalescing like-refresh GETs (root id → timer). */
  private likeRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(callbacks: FreenetCallbacks) {
    this.callbacks = callbacks;
  }

  connect(): void {
    // The app talks only to per-owner/per-thread shards + the identity delegate
    // (no global contract). Whether to connect at all is gated upstream by
    // __OFFLINE_MODE__ in index.ts (offline skips connect and renders mock
    // data), so connect() always opens the socket when called.
    this.callbacks.onStatusChange("connecting");

    try {
      const wsUrl = new URL(`ws://${location.host}/v1/contract/command`);

      const handler: ResponseHandler = {
        onContractPut: (_response: PutResponse) => {},
        onContractGet: (response: GetResponse) => {
          this.handleGetResponse(response);
        },
        onContractUpdate: (_response: UpdateResponse) => {},
        onContractUpdateNotification: (notification: UpdateNotification) => {
          this.handleUpdateNotification(notification);
        },
        onContractNotFound: (_instanceId: Uint8Array) => {
          // A shard probe against a not-yet-instantiated key rejects the
          // awaited get() (handled there); the live feed need not error.
          console.warn("[freenet] Contract not found");
        },
        onDelegateResponse: (response: DelegateResponse) => {
          this.callbacks.onDelegateResponse?.(response);
        },
        onErr: (err: HostError) => {
          console.error("[freenet] Error:", err.cause);
          this.callbacks.onStatusChange("error");
        },
        onOpen: () => {
          console.log("[freenet] Connected to Freenet node");
          this.callbacks.onStatusChange("connected");
        },
      };
      // Pass empty string as authToken to skip cookie reading (sandbox blocks it)
      this.api = new FreenetWsApi(wsUrl, handler, "");
    } catch (e) {
      console.warn("[freenet] Connection failed:", e);
      this.callbacks.onStatusChange("error");
    }
  }

  /**
   * Issue a GET serialised behind {@link getChain}, so it is the only GET in
   * flight when its response arrives — defeating the stdlib's uncorrelated FIFO
   * response queue. The returned promise resolves/rejects exactly with THIS
   * GET's response (since no other GET overlaps it), and the chain advances on
   * settle (success or failure) so one rejected/timed-out GET cannot wedge the
   * rest. A per-GET timeout bounds head-of-line blocking.
   */
  private serializedGet(req: GetRequest, ms = 8000): Promise<GetResponse> {
    if (!this.api) return Promise.reject(new Error("no api"));
    const api = this.api;
    const run = this.getChain.then(
      () => this.withTimeout(api.get(req), ms),
      () => this.withTimeout(api.get(req), ms),
    );
    // Advance the chain on settle without propagating this GET's result/error
    // to the next link (each caller still sees its own outcome via `run`).
    this.getChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  loadState(): void {
    // The feed is sourced solely from the owner's user shard. index.ts refreshes
    // via loadState after a publish, so this targets the same key writes go to.
    if (!this.api || !this.userShardKey) return;
    this.serializedGet(new GetRequest(this.userShardKey, true)).catch((e) =>
      console.error("[freenet] Get request failed:", e)
    );
  }

  /** Base58 instance id of a response's key, for matching against our keys. */
  private responseInstanceId(key: ContractKey | null | undefined): string | null {
    try {
      return key ? key.encode() : null;
    } catch {
      return null;
    }
  }

  private handleGetResponse(response: GetResponse): void {
    try {
      const respId = this.responseInstanceId(response.key);
      // Thread-shard GET (a like refresh / subscription): recompute the post's
      // like aggregate and emit it, independent of the user-shard feed below.
      const threadRoot = respId ? this.threadInstanceToRoot.get(respId) : undefined;
      if (threadRoot) {
        const json = new TextDecoder("utf8").decode(Uint8Array.from(response.state));
        const thread = JSON.parse(json) as ThreadShardState;
        this.emitLikeState(threadRoot, thread.likes ?? {});
        return;
      }
      // The only other GET source is the owner's user shard. Drop anything else.
      if (this.userShardInstanceId === null || respId !== this.userShardInstanceId) {
        return;
      }
      const stateJson = new TextDecoder("utf8").decode(
        Uint8Array.from(response.state),
      );
      const rawPosts = (JSON.parse(stateJson) as UserShardState).posts ?? [];
      const posts = rawPosts.map(contractPostToUiPost);
      // Sort by timestamp descending (newest first)
      posts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      this.callbacks.onPostsLoaded(posts);
    } catch (e) {
      console.error("[freenet] Failed to parse state:", e);
    }
  }

  private handleUpdateNotification(notification: UpdateNotification): void {
    try {
      const notifId = this.responseInstanceId(notification.key);
      // Thread-shard update (a like landed): re-GET for the authoritative
      // aggregate rather than reconciling the delta by hand.
      const threadRoot = notifId ? this.threadInstanceToRoot.get(notifId) : undefined;
      if (threadRoot) {
        this.refreshLikes(threadRoot);
        return;
      }
      // The only other update source is the owner's user shard.
      if (this.userShardInstanceId === null || notifId !== this.userShardInstanceId) {
        return;
      }
      const updateData = notification.update as UpdateData;
      if (!updateData || updateData.updateDataType !== UpdateDataType.DeltaUpdate) return;
      const delta = updateData.updateData as { delta: number[] } | null;
      if (!delta) return;
      const decoder = new TextDecoder("utf8");
      const deltaJson = decoder.decode(Uint8Array.from(delta.delta));
      // User-shard deltas are the externally-tagged `ShardDelta` enum
      // (`{"Posts":[…]}` / `{"Op":…}`). Op deltas (profile/follow) carry no feed
      // posts — ignore them here.
      const parsed = JSON.parse(deltaJson.replace(/\x00/g, "")) as {
        Posts?: ContractPost[];
        Op?: unknown;
      };
      for (const cp of parsed.Posts ?? []) {
        this.callbacks.onNewPost(contractPostToUiPost(cp));
      }
    } catch (e) {
      console.error("[freenet] Failed to parse update:", e);
    }
  }

  setUser(pubkey: string, name: string, handle: string): void {
    this.currentUser = { pubkey, name, handle };
    // A real ML-DSA-65 VK is 1952 bytes → 3904 hex chars. The offline fallback
    // identity uses a 32-byte fake (64 hex chars), which is not a shard owner.
    if (pubkey && pubkey.length === 3904 && pubkey !== this.ownerVkHex) {
      this.ownerVkHex = pubkey;
      void this.initUserShard();
    }
  }

  /**
   * Derive this owner's user-shard key, ensure the contract is instantiated on
   * the node (PUT the parameterized container if it is not yet present), then
   * load + subscribe so the feed reflects the owner's shard. ADR-0001 Phase 4.
   */
  private async initUserShard(): Promise<void> {
    const owner = this.ownerVkHex;
    // Re-entry guard keyed by owner: a duplicate Identity for the same owner is
    // a no-op, but a new owner (identity switch) must re-initialise.
    if (!this.api || !owner || this.userShardInitOwner === owner) return;
    const codeHash =
      typeof __USER_SHARD_CODE_HASH__ !== "undefined"
        ? __USER_SHARD_CODE_HASH__
        : null;
    if (!codeHash || codeHash === "DEV_MODE_NO_CONTRACT_HASH") {
      console.warn("[user-shard] No code hash injected — feed unavailable");
      return;
    }
    this.userShardInitOwner = owner;
    try {
      // GET-response ordering is handled by serializedGet (one GET in flight at
      // a time), so shard init no longer needs a startup barrier — it can issue
      // its probe/load GETs concurrently with any other flow and the chain
      // keeps each GET's response matched to its own promise.
      const vkBytes = hexToBytes(owner);
      this.userShardKey = deriveShardContractKey(codeHash, vkBytes);
      this.userShardInstanceId = this.userShardKey.encode();
      console.log(
        `[user-shard] derived key ${this.userShardInstanceId} for owner ${owner.slice(0, 8)}…`,
      );

      // Probe for an existing instance. A brand-new owner has none, so PUT the
      // parameterized container (raw WASM + owner VK params + empty initial
      // state) to instantiate it before subscribing.
      const exists = await this.userShardExists();
      if (!exists) {
        await this.putUserShard(vkBytes, codeHash);
      }

      this.loadUserShard();
      this.subscribeUserShard();
    } catch (e) {
      console.error("[user-shard] init failed:", e);
      // No fallback contract — clear so a later setUser can retry.
      this.userShardKey = null;
      this.userShardInstanceId = null;
      this.userShardInitOwner = null;
    }
  }

  /**
   * GET the user shard to check whether the node already has this instance.
   * A genuine not-found AND a transient timeout both return false → we PUT. A
   * spurious PUT over an already-existing shard is safe: Freenet PUT-of-existing
   * runs the contract's CRDT merge (`update_state` → `merge_state`), not an
   * overwrite, so PUTting the empty `{"posts":[]}` initial state merges to a
   * no-op (posts union / profile LWW / follows set-union). The only cost is
   * re-sending the WASM on a slow GET.
   */
  private async userShardExists(): Promise<boolean> {
    if (!this.api || !this.userShardKey) return false;
    try {
      await this.serializedGet(new GetRequest(this.userShardKey, false));
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch the bundled raw shard WASM bytes (served at the dist root). */
  private async fetchShardWasm(): Promise<Uint8Array> {
    const resp = await fetch("./user_shard.wasm");
    if (!resp.ok) {
      throw new Error(`failed to fetch user_shard.wasm: ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  /**
   * PUT the parameterized user-shard container to instantiate this owner's
   * shard. The node re-hashes the `data` bytes to derive the key, so the
   * shipped WASM must be the raw compiled artifact whose blake3 equals the
   * injected code hash (see Makefile.toml build-user-shard).
   */
  private async putUserShard(
    vkBytes: Uint8Array,
    codeHashBase58: string,
  ): Promise<void> {
    if (!this.api || !this.userShardKey) return;
    const wasm = await this.fetchShardWasm();
    const codeHashBytes = this.userShardKey.codePart();
    const code = new ContractCodeT(
      Array.from(wasm),
      codeHashBytes ? Array.from(codeHashBytes) : [],
    );
    const contract = new WasmContractV1(
      code,
      Array.from(vkBytes),
      this.userShardKey,
    );
    const container = new ContractContainer(
      WasmContractType.WasmContractV1,
      contract,
    );
    // Empty initial state; `UserShard` defaults fill the rest (posts: []).
    const initialState = new TextEncoder().encode(
      JSON.stringify({ posts: [] }),
    );
    const req = new PutRequest(
      container,
      Array.from(initialState),
      undefined,
      false,
      false,
    );
    console.log(
      `[user-shard] PUT instantiating shard (${codeHashBase58.slice(0, 8)}…)`,
    );
    await this.api.put(req);
  }

  private loadUserShard(): void {
    if (!this.api || !this.userShardKey) return;
    this.serializedGet(new GetRequest(this.userShardKey, true)).catch((e) =>
      console.error("[user-shard] get failed:", e),
    );
  }

  private subscribeUserShard(): void {
    if (!this.api || !this.userShardKey) return;
    this.api
      .subscribe(new SubscribeRequest(this.userShardKey, []))
      .catch((e) => console.error("[user-shard] subscribe failed:", e));
  }

  // --- Thread shard: likes (ADR-0001 Phase 4 slice 2) ----------------------

  /**
   * Derive (and cache) the thread-shard key for a post. A thread shard is
   * parameterized by its root post id, so the key is
   * blake3(thread_code_hash || utf8(post_id)) — note the parameter is the UTF-8
   * bytes of the id string, matching the contract's
   * `String::from_utf8_lossy(parameters)`, NOT raw/hex-decoded bytes.
   */
  private threadKeyFor(rootPostId: string): ContractKey | null {
    const cached = this.threadKeys.get(rootPostId);
    if (cached) return cached;
    const codeHash =
      typeof __THREAD_SHARD_CODE_HASH__ !== "undefined"
        ? __THREAD_SHARD_CODE_HASH__
        : null;
    if (!codeHash || codeHash === "DEV_MODE_NO_CONTRACT_HASH") return null;
    const params = new TextEncoder().encode(rootPostId);
    const key = deriveShardContractKey(codeHash, params);
    this.threadKeys.set(rootPostId, key);
    this.threadInstanceToRoot.set(key.encode(), rootPostId);
    return key;
  }

  /** Fetch the bundled raw thread-shard WASM bytes (served at the dist root). */
  private async fetchThreadWasm(): Promise<Uint8Array> {
    const resp = await fetch("./thread_shard.wasm");
    if (!resp.ok) {
      throw new Error(`failed to fetch thread_shard.wasm: ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  /**
   * Ensure the post's thread shard is instantiated on the node: GET-probe, and
   * PUT the parameterized container if absent. Awaits the PUT before returning,
   * so the caller knows the shard exists before sending a like UpdateRequest
   * (an update to a never-instantiated contract is silently dropped by the
   * node — see M-3). Throws if the PUT itself fails.
   */
  private async ensureThreadShard(
    key: ContractKey,
    rootPostId: string,
  ): Promise<void> {
    if (!this.api) throw new Error("no api");
    try {
      await this.serializedGet(new GetRequest(key, false));
      return; // already instantiated
    } catch {
      // not found / timeout → PUT below (a spurious re-PUT merges to a no-op)
    }
    const wasm = await this.fetchThreadWasm();
    const codeHashBytes = key.codePart();
    const code = new ContractCodeT(
      Array.from(wasm),
      codeHashBytes ? Array.from(codeHashBytes) : [],
    );
    // Parameter = UTF-8 bytes of the root post id (matches the contract).
    const params = Array.from(new TextEncoder().encode(rootPostId));
    const contract = new WasmContractV1(code, params, key);
    const container = new ContractContainer(
      WasmContractType.WasmContractV1,
      contract,
    );
    const initialState = new TextEncoder().encode(
      JSON.stringify({ replies: {}, likes: {}, quotes: {} }),
    );
    await this.api.put(
      new PutRequest(container, Array.from(initialState), undefined, false, false),
    );
  }

  /**
   * Like or unlike a post. Derives/instantiates the post's thread shard, then
   * asks the delegate to sign a `LikeRecord`; the matching `SignedLike` is
   * routed to {@link completeLike}, which folds it into the thread shard via
   * `ThreadDelta::Likes`. Returns false if it cannot proceed (no delegate /
   * thread code hash). Optimistic UI is the caller's concern; the authoritative
   * count comes back via {@link refreshLikes} after the update lands.
   */
  async likePost(rootPostId: string, liked: boolean): Promise<boolean> {
    if (!this.api) return false;
    const key = this.threadKeyFor(rootPostId);
    if (!key) {
      console.warn("[thread] no thread-shard code hash — cannot like");
      return false;
    }
    try {
      await this.ensureThreadShard(key, rootPostId);
      this.subscribeThread(key);
    } catch (e) {
      console.error("[thread] ensure/subscribe failed:", e);
      return false;
    }
    const nonce = crypto.randomUUID();
    this.pendingLikes.push({ nonce, rootPostId, liked });
    // seq is the liker's monotonic counter; ms-precision time is monotonic
    // enough for a single user's like/unlike toggles (the contract resolves
    // concurrent same-key records by higher seq).
    const requested = signLike(nonce, rootPostId, Date.now(), liked);
    if (!requested) {
      this.pendingLikes.pop();
      console.warn("[thread] cannot like: delegate not connected to sign");
      return false;
    }
    return true;
  }

  /** Complete a like once the delegate returns a `SignedLike`. */
  async completeLike(signed: {
    nonce: string;
    root_post_id: string;
    signer_pubkey: string;
    seq: number;
    liked: boolean;
    signature: string;
  }): Promise<boolean> {
    if (!this.api) return false;
    const idx = this.pendingLikes.findIndex((p) => p.nonce === signed.nonce);
    if (idx === -1) {
      console.warn("[thread] SignedLike with no matching pending like", signed.nonce);
      return false;
    }
    this.pendingLikes.splice(idx, 1);
    const key = this.threadKeyFor(signed.root_post_id);
    if (!key) return false;

    const record: LikeRecord = {
      signer_pubkey: signed.signer_pubkey,
      seq: signed.seq,
      liked: signed.liked,
      signature: signed.signature,
    };
    try {
      const deltaBytes = new TextEncoder().encode(
        JSON.stringify({ Likes: [record] }),
      );
      const update = new UpdateData(
        UpdateDataType.DeltaUpdate,
        new DeltaUpdate(Array.from(deltaBytes)),
      );
      await this.api.update(new UpdateRequest(key, update));
      // Read back the authoritative aggregate once our own update lands — do it
      // immediately (not debounced) for snappy feedback on the user's own like.
      this.refreshLikesNow(signed.root_post_id);
      return true;
    } catch (e) {
      console.error("[thread] failed to send like:", e);
      // The update did not land — re-GET the authoritative aggregate so the
      // optimistic toggle is reconciled away (onLikeUpdated reverts the UI).
      this.refreshLikesNow(signed.root_post_id);
      return false;
    }
  }

  /** GET a post's thread shard now to recompute its like aggregate. */
  private refreshLikesNow(rootPostId: string): void {
    if (!this.api) return;
    const key = this.threadKeyFor(rootPostId);
    if (!key) return;
    this.serializedGet(new GetRequest(key, true)).catch((e) =>
      console.error("[thread] like refresh GET failed:", e),
    );
  }

  /**
   * Debounced like-refresh: coalesce a burst of thread update notifications
   * (e.g. a viral post drawing many remote likes) into one GET per thread per
   * window, instead of one full-state GET per notification.
   */
  private refreshLikes(rootPostId: string): void {
    const existing = this.likeRefreshTimers.get(rootPostId);
    if (existing) clearTimeout(existing);
    this.likeRefreshTimers.set(
      rootPostId,
      setTimeout(() => {
        this.likeRefreshTimers.delete(rootPostId);
        this.refreshLikesNow(rootPostId);
      }, 500),
    );
  }

  private subscribeThread(key: ContractKey): void {
    if (!this.api) return;
    this.api
      .subscribe(new SubscribeRequest(key, []))
      .catch((e) => console.error("[thread] subscribe failed:", e));
  }

  /**
   * Drop a pending like by nonce (delegate returned an Error for it). Returns
   * true if a pending like was actually dropped, so the caller can revert the
   * optimistic UI toggle for that like.
   */
  dropPendingLike(nonce: string): boolean {
    const idx = this.pendingLikes.findIndex((p) => p.nonce === nonce);
    if (idx === -1) return false;
    this.pendingLikes.splice(idx, 1);
    return true;
  }

  /**
   * Reduce a thread shard's `likes` map to an aggregate for the UI: count of
   * records with `liked == true`, and whether the current owner is among them.
   */
  private emitLikeState(rootPostId: string, likes: Record<string, LikeRecord>): void {
    let count = 0;
    let likedByMe = false;
    for (const rec of Object.values(likes)) {
      if (rec.liked) {
        count++;
        if (this.ownerVkHex && rec.signer_pubkey === this.ownerVkHex) {
          likedByMe = true;
        }
      }
    }
    this.callbacks.onLikeUpdated?.({ postId: rootPostId, count, likedByMe });
  }

  /**
   * Begin publishing a post. The delegate must sign it first (ML-DSA-65 over
   * the canonical payload) and assign the content-addressed id, so this stashes
   * the draft and fires a SignPost request. The matching `Signed` response is
   * routed to {@link completePublish}, which sends the signed post on-chain.
   * (Mirrors mail's pending-send pattern; delegate responses are not correlated
   * per-request, so we hold the draft until the signature returns.)
   */
  async publishPost(content: string): Promise<boolean> {
    // Posts go to the owner's user shard, instantiated once the identity is
    // known. No shard → cannot publish.
    if (!this.api || !this.userShardKey || !this.currentUser) {
      return false;
    }
    const timestamp = Date.now();
    // Per-request nonce uniquely identifies this draft. The Signed response
    // echoes it, so completePublish matches the exact draft even when two posts
    // share the same millisecond timestamp (Date.now() collision) — matching on
    // timestamp alone could otherwise pair the wrong content with a signature.
    const nonce = crypto.randomUUID();
    const draft: PendingPostDraft = {
      nonce,
      author_name: this.currentUser.name,
      author_handle: this.currentUser.handle,
      content,
      timestamp,
    };
    this.pendingPosts.push(draft);

    const requested = signPost(
      nonce,
      content,
      this.currentUser.name,
      this.currentUser.handle,
      timestamp
    );
    if (!requested) {
      // No delegate (offline) — cannot sign, so cannot publish.
      this.pendingPosts.pop();
      console.warn("[freenet] Cannot publish: delegate not connected to sign post");
      return false;
    }
    return true;
  }

  /**
   * Complete a publish once the delegate returns a `Signed` response: matches
   * the pending draft, assembles the signed ContractPost, and sends it.
   */
  async completePublish(signed: {
    nonce: string;
    post_id: string;
    signature: string;
    public_key: string;
  }): Promise<boolean> {
    if (!this.api || !this.userShardKey) return false;

    // Match the draft by its unique nonce, not position or timestamp — robust
    // to a dropped/errored sign request and to same-millisecond posts.
    const idx = this.pendingPosts.findIndex((d) => d.nonce === signed.nonce);
    if (idx === -1) {
      console.warn(
        "[freenet] Signed response with no matching pending draft",
        signed.nonce
      );
      return false;
    }
    const [draft] = this.pendingPosts.splice(idx, 1);

    const post: ContractPost = {
      id: signed.post_id,
      author_pubkey: signed.public_key,
      author_name: draft.author_name,
      author_handle: draft.author_handle,
      content: draft.content,
      timestamp: draft.timestamp,
      signature: signed.signature,
    };

    try {
      const encoder = new TextEncoder();
      // The user shard expects the externally-tagged `ShardDelta::Posts` form.
      const deltaBytes = encoder.encode(JSON.stringify({ Posts: [post] }));
      const delta = new DeltaUpdate(Array.from(deltaBytes));
      const update = new UpdateData(UpdateDataType.DeltaUpdate, delta);
      const req = new UpdateRequest(this.userShardKey, update);
      await this.api.update(req);
      return true;
    } catch (e) {
      console.error("[freenet] Failed to publish:", e);
      return false;
    }
  }

  /**
   * Drop a specific pending post draft by nonce. Called when the delegate
   * returns an Error carrying the originating nonce (a SignPost that failed),
   * so only the stranded draft is removed — unrelated errors (GetIdentity,
   * Export, …) carry no nonce and leave the queue untouched.
   */
  dropPendingPost(nonce: string): void {
    const idx = this.pendingPosts.findIndex((d) => d.nonce === nonce);
    if (idx !== -1) this.pendingPosts.splice(idx, 1);
  }

  /**
   * Expose the underlying FreenetWsApi so delegate-api.ts can access it.
   * Returns null when not yet connected.
   */
  get wsApi(): FreenetWsApi | null {
    return this.api;
  }

  get isConnected(): boolean {
    return this.api !== null;
  }
}
