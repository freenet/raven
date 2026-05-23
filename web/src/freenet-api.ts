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

// Contract post format (matches Rust contract)
interface ContractPost {
  id: string;
  author_pubkey: string;
  author_name: string;
  author_handle: string;
  content: string;
  timestamp: number;
  signature: number[] | null;
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

  async publishPost(content: string): Promise<boolean> {
    if (!this.api || !this.contractKey || !this.currentUser) {
      return false;
    }

    const post: ContractPost = {
      id: `${this.currentUser.pubkey.slice(0, 16)}-${Date.now()}`,
      author_pubkey: this.currentUser.pubkey,
      author_name: this.currentUser.name,
      author_handle: this.currentUser.handle,
      content,
      timestamp: Date.now(),
      signature: null,
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
