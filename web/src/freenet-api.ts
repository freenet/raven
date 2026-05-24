import {
  FreenetWsApi,
  ContractKey,
  GetRequest,
  GetResponse,
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
import { Post } from "./types";
import { signPost } from "./identity";
import { runMigrations, type MigrationRunnerDeps } from "./migrations/run";
import {
  LocalStorageMigrationStateStore,
  type MigrationStateStore,
} from "./migrations/state-store";
import {
  CURRENT_POSTS_CODE_HASH,
  LEGACY_POSTS_CODE_HASHES,
  type ContractType,
  type MigratableContract,
} from "./migrations/legacy-hashes";

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

interface PostsFeedState {
  posts: ContractPost[];
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
  /** Optional: one-line progress messages from the startup migration loop. */
  onMigration?: (message: string) => void;
}

export class FreenetConnection {
  private api: FreenetWsApi | null = null;
  private contractKey: ContractKey | null = null;
  private callbacks: FreenetCallbacks;
  private currentUser: {
    pubkey: string;
    name: string;
    handle: string;
  } | null = null;
  private migrationStore: MigrationStateStore =
    new LocalStorageMigrationStateStore();
  /** True while the startup migration loop probes old contract keys. */
  private migrating = false;
  /** Drafts awaiting a delegate `Signed` response, FIFO. See publishPost. */
  private pendingPosts: PendingPostDraft[] = [];

  constructor(callbacks: FreenetCallbacks) {
    this.callbacks = callbacks;
  }

  connect(): void {
    const modelContract =
      typeof __MODEL_CONTRACT__ !== "undefined" ? __MODEL_CONTRACT__ : null;

    if (!modelContract || modelContract === "DEV_MODE_NO_CONTRACT_HASH") {
      console.log("[freenet] No contract hash — running in mock mode");
      this.callbacks.onStatusChange("disconnected");
      return;
    }

    this.callbacks.onStatusChange("connecting");

    try {
      // Build ContractKey with both instance and code parts.
      // fromInstanceId only sets instance — we need both for the node.
      // The published contract key (base58) decodes to 32 bytes that serve
      // as both instance ID and code hash (when no parameters are used).
      this.contractKey = this.deriveContractKey(modelContract);
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
          // A migration probe against an old key that no longer exists is
          // expected — the awaited get() rejects and is handled there.
          if (this.migrating) return;
          console.warn("[freenet] Contract not found");
          this.callbacks.onStatusChange("error");
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
          void this.startup();
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
   * Derive the node ContractKey from a base58 instance id. The published key
   * decodes to 32 bytes that serve as both instance id and code hash when the
   * contract uses no parameters.
   */
  private deriveContractKey(instanceId: string): ContractKey {
    const keyFromId = ContractKey.fromInstanceId(instanceId);
    const bytes = keyFromId.bytes();
    return new ContractKey(bytes, bytes);
  }

  /** Run the migration loop, then load + subscribe to the current contract. */
  private async startup(): Promise<void> {
    await this.runStartupMigrations();
    this.loadState();
    this.subscribeToUpdates();
  }

  /**
   * Detect a contract-hash bump since the last session and pull any state
   * stranded under the old key into the current contract. Runs before
   * subscribeToUpdates so the live feed reflects migrated state.
   */
  private async runStartupMigrations(): Promise<void> {
    if (!this.api || !this.contractKey) return;

    const log = (message: string) => {
      console.log(message);
      this.callbacks.onMigration?.(message);
    };

    const contracts: MigratableContract[] = [
      {
        type: "posts",
        currentHash: CURRENT_POSTS_CODE_HASH,
        legacyHashes: LEGACY_POSTS_CODE_HASHES,
      },
    ];

    const deps: MigrationRunnerDeps = {
      store: this.migrationStore,
      getState: (type, candidateHash) =>
        this.migrationGetState(type, candidateHash),
      reinject: (type, state) => this.migrationReinject(type, state),
      log,
    };

    this.migrating = true;
    try {
      await runMigrations(contracts, deps);
    } catch (e) {
      console.error("[migration] startup migration failed:", e);
    } finally {
      this.migrating = false;
    }
  }

  /** GET the state stored under an old contract key; null if unavailable. */
  private async migrationGetState(
    _type: ContractType,
    candidateHash: string,
  ): Promise<unknown | null> {
    if (!this.api) return null;
    const key = this.deriveContractKey(candidateHash);
    try {
      const resp = await this.withTimeout(
        this.api.get(new GetRequest(key, false)),
        8000,
      );
      const json = new TextDecoder("utf8").decode(Uint8Array.from(resp.state));
      return JSON.parse(json);
    } catch (e) {
      console.warn(`[migration] GET candidate ${candidateHash} failed:`, e);
      return null;
    }
  }

  /** Merge migrated state into the current contract via a delta update. */
  private async migrationReinject(
    type: ContractType,
    state: unknown,
  ): Promise<void> {
    if (!this.api || !this.contractKey) return;
    // Only posts is wired into the UI today; follows/likes land with #11/#13.
    if (type !== "posts") return;
    const posts = (state as PostsFeedState | null)?.posts;
    if (!Array.isArray(posts) || posts.length === 0) return;
    const deltaBytes = new TextEncoder().encode(JSON.stringify(posts));
    const update = new UpdateData(
      UpdateDataType.DeltaUpdate,
      new DeltaUpdate(Array.from(deltaBytes)),
    );
    await this.api.update(new UpdateRequest(this.contractKey, update));
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
    if (!this.api || !this.contractKey) return;
    const req = new GetRequest(this.contractKey, true);
    this.api.get(req).catch((e) =>
      console.error("[freenet] Get request failed:", e)
    );
  }

  private subscribeToUpdates(): void {
    if (!this.api || !this.contractKey) return;
    const req = new SubscribeRequest(this.contractKey, []);
    this.api.subscribe(req).catch((e) =>
      console.error("[freenet] Subscribe request failed:", e)
    );
  }

  private handleGetResponse(response: GetResponse): void {
    // The startup migration loop issues GETs against old contract keys and
    // consumes those responses via the awaited Promise returned by api.get().
    // The same responses also reach this handler — skip them so old-version
    // state never lands in the live feed.
    if (this.migrating) return;
    try {
      const decoder = new TextDecoder("utf8");
      const stateJson = decoder.decode(Uint8Array.from(response.state));
      const state: PostsFeedState = JSON.parse(stateJson);
      const posts = state.posts.map(contractPostToUiPost);
      // Sort by timestamp descending (newest first)
      posts.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      this.callbacks.onPostsLoaded(posts);
    } catch (e) {
      console.error("[freenet] Failed to parse state:", e);
    }
  }

  private handleUpdateNotification(notification: UpdateNotification): void {
    try {
      const updateData = notification.update as UpdateData;
      if (!updateData || updateData.updateDataType !== UpdateDataType.DeltaUpdate) return;
      const delta = updateData.updateData as { delta: number[] } | null;
      if (!delta) return;
      const decoder = new TextDecoder("utf8");
      const deltaJson = decoder.decode(Uint8Array.from(delta.delta));
      const newPosts: ContractPost[] = JSON.parse(
        deltaJson.replace("\x00", "")
      );
      for (const cp of newPosts) {
        this.callbacks.onNewPost(contractPostToUiPost(cp));
      }
    } catch (e) {
      console.error("[freenet] Failed to parse update:", e);
    }
  }

  setUser(pubkey: string, name: string, handle: string): void {
    this.currentUser = { pubkey, name, handle };
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
    if (!this.api || !this.contractKey || !this.currentUser) {
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
    if (!this.api || !this.contractKey) return false;

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
      const deltaBytes = encoder.encode(JSON.stringify([post]));
      const delta = new DeltaUpdate(Array.from(deltaBytes));
      const update = new UpdateData(UpdateDataType.DeltaUpdate, delta);
      const req = new UpdateRequest(this.contractKey, update);
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
