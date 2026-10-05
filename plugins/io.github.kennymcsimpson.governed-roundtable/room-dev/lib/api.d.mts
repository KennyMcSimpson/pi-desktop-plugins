// Types for lib/api.mjs, the embedding API (INTERFACES §15). Hand-written; keep in step with api.mjs.

export interface CommandResult {
  /** Exit code the CLI would have used: 0 for every expected outcome, 2 REJECTED, 8 PENDING/NO_SERVICE, 9 error. */
  code: number;
  /** First word of the first printed line: TURN, TURN_OVER, NOT_YOUR_TURN, ACCEPTED, REJECTED, QUEUED, SEAT, INIT, FROZEN, ERROR ... */
  status: string;
  /** key=value pairs of that first line, e.g. {attempt, nonce, packet, sha256} for TURN. */
  fields: Record<string, string>;
  /** Everything the command printed, in order. */
  lines: string[];
  /** Refusal or usage message when status is ERROR. */
  error?: string;
}

export type Params = Record<string, string | number | boolean | null | undefined | ReadonlyArray<string | number>>;

export function toArgv(params?: Params): string[];
export function parseResultLine(line: string): { status: string; fields: Record<string, string> };
/** The packet path of a TURN line, spaces included (parseResultLine cuts it at the first space); null if absent. */
export function turnPacketPath(line: string): string | null;

export function admin(sub: string, params?: Params, positional?: ReadonlyArray<string | number>): Promise<CommandResult>;
export function createRoom(params: Params): Promise<CommandResult & { roomDir: string | null }>;
export function addSeat(params: Params): Promise<CommandResult & { joinPath: string | null }>;

export interface HostedHandle {
  busy?: boolean;
  tier?: string;
  prompt(packetText: string, opts?: { signal?: AbortSignal }): Promise<{
    text?: string;
    stopReason: 'end_turn' | 'cancelled' | 'error';
    usage?: { input?: number | null; output?: number | null; cached?: number | null } | null;
    failureClass?: 'rate_limited' | 'quota_exhausted' | 'auth_expired' | 'crashed' | 'denied' | 'other';
    error?: { code?: string; message?: string };
    unconfirmed?: boolean;
  }>;
  cancel?(): unknown;
  pendingPermissions?(): unknown[];
}
export type HostedProviderFactory = (ctx: { seat: Record<string, unknown>; roomDir: string; log: (line: string) => void }) => HostedHandle;

export interface OpenRoomOptions {
  roomDir: string;
  tickMs?: number;
  /** Loopback UI/API port (127.0.0.1); 0 picks a free port. Omit for no HTTP. */
  port?: number;
  log?: (line: string) => void;
  /** Providers for seats added with --hosted lane:<name>; keyed by hosted kind ('lane'). */
  hostedProviders?: Record<string, HostedProviderFactory>;
  /** Wake delivery for seats registered with --wake-kind <kind> (default codex-queue is built in).
   *  Called at most wake.maxPerTurn times per turn with a fixed text that carries no room content. */
  wakers?: Record<string, (ctx: { seat: Record<string, unknown>; attemptId: string | null; thread: string; text: string }) => Promise<{ ok: boolean; detail?: string }> | { ok: boolean; detail?: string }>;
  piApiKey?: string;
  [option: string]: unknown;
}

export interface RoomHandle {
  readonly roomDir: string;
  readonly service: unknown;
  readonly url: string | null;
  readonly adminToken: string;
  readonly closed: boolean;
  view(): Record<string, any>;
  events(since?: number): Array<Record<string, any>>;
  admin(cmd: string, params?: Record<string, unknown>): Promise<Record<string, any>>;
  tickNow(): Promise<unknown>;
  close(): Promise<void>;
}
export function openRoom(options: OpenRoomOptions): Promise<RoomHandle>;

export interface SeatClient {
  readonly seatId: string;
  readonly seatDir: string;
  readonly seat: Record<string, any>;
  cmd(name: string, params?: Params, positional?: ReadonlyArray<string | number>): Promise<CommandResult>;
  wait(opts?: { timeoutSec?: number; once?: boolean }): Promise<CommandResult>;
  status(opts?: { log?: boolean; whoami?: boolean }): Promise<CommandResult>;
  submit(opts: { attemptId: string; text?: string; file?: string }): Promise<CommandResult>;
  leave(): Promise<CommandResult>;
  pass(opts: { attemptId: string }): Promise<CommandResult>;
  point(opts: { attemptId: string; seq: number; text: string }): Promise<CommandResult>;
  quote(opts: { attemptId: string; seq: number; text: string }): Promise<CommandResult>;
  mark(opts: { attemptId: string; item: string; status: 'accepted' | 'rejected' | 'deferred'; text?: string }): Promise<CommandResult>;
  misquoted(opts: { attemptId: string; seq: number; text: string }): Promise<CommandResult>;
  verdict(opts: { attemptId: string; value: 'pass' | 'reject' | 'disclose'; artifact: string; text?: string }): Promise<CommandResult>;
  disclose(opts: { attemptId: string; argv: string[]; reason: string }): Promise<CommandResult>;
  assign(opts: { attemptId: string; text?: string; file?: string }): Promise<CommandResult>;
  artifacts(opts: { attemptId: string; paths: string[]; baseline?: string; exclude?: string }): Promise<CommandResult>;
  readPacket(packetPath: string): string;
}
export function seatClient(opts: { roomDir: string; seatId: string }): SeatClient;
