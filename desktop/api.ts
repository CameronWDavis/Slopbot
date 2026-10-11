// The typed surface the renderer gets via contextBridge (window.slopbot).

export interface BotSummary {
  name: string;
  description: string;
  model: string;
  tools: string[];
  schedules: { name: string; cron: string; task: string }[];
}

export interface ApprovalRequest {
  id: string;
  bot: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface QueuedApproval {
  id: string;
  bot: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  createdAt: string;
}

export type AgentEvent =
  | { type: "run.start"; bot: string }
  | { type: "text"; bot: string; text: string }
  | { type: "tool.call"; bot: string; id: string; name: string; args: Record<string, unknown>; decision: string; reason: string }
  | { type: "tool.result"; bot: string; id: string; name: string; ok: boolean; result: string }
  | { type: "run.end"; bot: string; text: string; steps: number; tokens: number; pending: string[] }
  | { type: "run.error"; bot: string; error: string };

export interface ActivityItem {
  ts: string;
  bot: string;
  type: string;
  summary: string;
}

export type Risk = "read" | "write" | "external" | "dangerous";

export interface McpServerDef {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  bots?: string[];
  enabled?: boolean;
  description?: string;
  trusted?: boolean;
}

export interface McpToolInfo {
  name: string;
  slopName: string;
  description: string;
  risk: Risk;
  claimsReadOnly?: boolean;
}

export interface McpServerStatus {
  name: string;
  def: McpServerDef;
  state: "disabled" | "idle" | "connecting" | "connected" | "error" | "needs_auth";
  error?: string;
  oauth?: "signed_in" | "signed_out";
  tools: McpToolInfo[];
}

export interface OllamaModel {
  name: string;
  size: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  capabilities?: string[];
  loaded?: boolean;
  vram?: number;
}

export interface OllamaStatus {
  running: boolean;
  version: string | null;
  installed: boolean;
  baseUrl: string;
  ramBytes: number;
  provider: string;
  defaultModel: string;
  bots: { name: string; model: string }[];
  models: OllamaModel[];
  pulling: string[];
}

export interface PullProgress {
  model: string;
  status: string;
  completed: number;
  total: number;
  done?: boolean;
  error?: string;
}

export interface VaultEntryInfo {
  id: string;
  name: string;
  kind: "api_key" | "login";
  domains: string[];
  username?: string;
  sendAs?: "bearer" | "header" | "query";
  field?: string;
  bots: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  hasSecret: boolean;
}

export type SearchProvider = "auto" | "ollama" | "brave" | "tavily" | "searxng" | "basic";

export interface SearchSettings {
  provider: SearchProvider;
  searxngUrl: string;
  keys: Record<string, boolean>;
  active: string;
  problem: string;
}

export interface TelegramStatus {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  botUsername?: string;
  linked: boolean;
  ownerName?: string;
  linkedAt?: string;
  defaultBot?: string;
  pairing?: { code: string; expiresAt: number; link?: string };
  error?: string;
  rejected: number;
}

export interface SkillInfo {
  name: string;
  description: string;
  bots: string[];
  /** Bots whose YAML file lists this skill (always on for them; change it in the file). */
  yamlBots: string[];
  /** Ships with SlopBot (read-only; editing saves your own copy). */
  bundled?: boolean;
  enabled: boolean;
  license?: string;
  error?: string;
  files: number;
}

export interface SkillDraft {
  name: string;
  description: string;
  instructions: string;
  bots: string[];
  previousName?: string;
}

export interface MoneyInfo {
  /** Integer minor units (cents). */
  minor: number;
  currency: string;
}

export type WatchKind = "product" | "feed" | "x_account" | "x_search";

export interface WatchInfo {
  id: string;
  name: string;
  kind: WatchKind;
  url?: string;
  xQuery?: string;
  keywords: string[];
  exclude: string[];
  variants: string[];
  sellers: string[];
  target?: MoneyInfo;
  currency: string;
  maxTotal?: MoneyInfo;
  everyMinutes: number;
  enabled: boolean;
  createdAt: string;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  nextCheckAt?: string;
  failures: number;
  lastError?: string;
  lastHint?: string;
  lastSummary?: string;
  lastPrice?: MoneyInfo;
  lastInStock?: boolean;
  lastTitle?: string;
  lastSeller?: string;
}

export type DealStatus = "pending" | "expired" | "skipped" | "queued" | "reviewing" | "paused" | "submitted" | "confirmed" | "failed" | "uncertain";

export interface DealInfo {
  id: string;
  watchId: string;
  watchName: string;
  sources: string[];
  postUrl?: string;
  listing: { url: string; title: string; price: MoneyInfo; seller?: string; inStock?: boolean; checkedAt: string };
  quantity: 1;
  cap: MoneyInfo;
  approval?: { nonce: string; expiresAt: string };
  status: DealStatus;
  note?: string;
  foundAt: string;
  updatedAt: string;
  execution?: { total?: MoneyInfo; orderId?: string; submittedAt?: string; finishedAt?: string };
}

export interface ShoppingSettingsInfo {
  extraAllowancePct: number;
  approvalMinutes: number;
  savedFeeds: { label: string; url: string }[];
  renderService: "none" | "scrapingbee" | "scraperapi";
  xMonthlyLimit: number;
  xUsage: { month: string; posts: number; requests: number };
}

export interface ShoppingSnapshot {
  watches: WatchInfo[];
  deals: DealInfo[];
  settings: ShoppingSettingsInfo;
  /** The model that does checkout, and whether it runs on this computer. */
  model: { model: string; local: boolean };
  autoBuy: boolean;
  buying: boolean;
}

export interface WatchDraft {
  id?: string;
  name?: string;
  kind: WatchKind;
  url?: string;
  xQuery?: string;
  keywords?: string[];
  exclude?: string[];
  variants?: string[];
  sellers?: string[];
  /** As typed, in major units ("499.99"). */
  targetPrice?: string;
  maxTotal?: string;
  currency?: string;
  everyMinutes?: number;
  enabled?: boolean;
}

export type SourceId = "x" | "scrapingbee" | "scraperapi";

export interface SourceInfo {
  id: SourceId;
  label: string;
  keyLabel: string;
  getKey: string;
  note: string;
  configured: boolean;
  /** Last 4 characters only. */
  masked: string;
  lastTest?: { ok: boolean; message: string; at: string };
}

export interface SlopbotApi {
  info(): Promise<{ dataDir: string; rootDir: string; homeDir: string; defaultModel: string; version: string; secrets: "keychain" | "dpapi" | "libsecret" | "file" }>;
  listBots(): Promise<BotSummary[]>;
  listModels(): Promise<string[]>;
  send(bot: string, text: string, model?: string): Promise<void>;
  reset(bot: string): Promise<void>;
  answerApproval(id: string, answer: "yes" | "no" | "always"): Promise<void>;
  listApprovals(): Promise<QueuedApproval[]>;
  resolveApproval(id: string, approve: boolean): Promise<string>;
  activity(limit?: number): Promise<ActivityItem[]>;
  memory(bot: string): Promise<{ id: string; text: string }[]>;
  openDataDir(): Promise<void>;
  mcpList(): Promise<McpServerStatus[]>;
  mcpConnect(name: string): Promise<McpServerStatus>;
  mcpTest(name: string, def: McpServerDef): Promise<McpToolInfo[]>;
  mcpSave(name: string, def: McpServerDef, previousName?: string): Promise<void>;
  mcpRemove(name: string): Promise<void>;
  mcpImport(json: string, bots: string[]): Promise<string[]>;
  mcpSignIn(name: string): Promise<McpServerStatus>;
  mcpSignOut(name: string): Promise<void>;
  shoppingState(): Promise<ShoppingSnapshot>;
  shoppingSaveWatch(w: WatchDraft): Promise<WatchInfo>;
  shoppingRemoveWatch(id: string): Promise<void>;
  shoppingSetEnabled(id: string, on: boolean): Promise<void>;
  shoppingCheck(id: string): Promise<{ ok: boolean; summary: string; hint?: string }>;
  /** Buy is bound to the deal's current approval nonce. */
  shoppingBuy(dealId: string, nonce: string): Promise<void>;
  shoppingSkip(dealId: string): Promise<void>;
  shoppingRecheck(dealId: string): Promise<void>;
  shoppingResume(dealId: string): Promise<void>;
  shoppingCancel(dealId: string): Promise<void>;
  shoppingResolve(dealId: string, ordered: boolean): Promise<void>;
  shoppingSaveSettings(patch: Partial<ShoppingSettingsInfo>): Promise<ShoppingSettingsInfo>;
  shoppingOpenBrowser(url?: string): Promise<void>;
  shoppingClearHistory(): Promise<void>;
  shoppingClearSignIns(): Promise<void>;
  sourcesList(): Promise<SourceInfo[]>;
  sourcesSave(id: SourceId, key: string): Promise<{ ok: boolean; message: string }>;
  sourcesRemove(id: SourceId): Promise<void>;
  sourcesTest(id: SourceId): Promise<{ ok: boolean; message: string }>;
  onShoppingChanged(cb: () => void): () => void;
  onShowShopping(cb: () => void): () => void;
  skillsList(): Promise<SkillInfo[]>;
  skillsGet(name: string): Promise<{ name: string; description: string; instructions: string; files: string[] }>;
  skillsSave(draft: SkillDraft): Promise<string>;
  /** Opens a file picker; resolves to the new skill's name, or null if cancelled. */
  skillsImport(bots: string[]): Promise<string | null>;
  skillsAssign(name: string, bots: string[], enabled: boolean): Promise<void>;
  skillsRemove(name: string): Promise<void>;
  skillsReveal(name?: string): Promise<void>;
  vaultList(): Promise<VaultEntryInfo[]>;
  vaultSave(input: Partial<VaultEntryInfo> & { name: string; kind: VaultEntryInfo["kind"]; secret?: string }): Promise<VaultEntryInfo>;
  vaultRemove(id: string): Promise<void>;
  searchGet(): Promise<SearchSettings>;
  searchSave(s: { provider: SearchProvider; searxngUrl?: string; key?: { provider: SearchProvider; value: string } }): Promise<void>;
  searchForgetKey(provider: SearchProvider): Promise<void>;
  searchTest(query: string): Promise<{ provider: string; results: { title: string; url: string; snippet: string }[] }>;
  telegramStatus(): Promise<TelegramStatus>;
  telegramSetToken(token: string): Promise<string>;
  telegramPair(): Promise<TelegramStatus["pairing"]>;
  telegramUnlink(): Promise<void>;
  telegramSetDefaultBot(bot: string): Promise<void>;
  telegramSetEnabled(on: boolean): Promise<void>;
  telegramRemoveToken(): Promise<void>;
  onTelegramStatus(cb: (s: TelegramStatus) => void): () => void;
  ollamaStatus(): Promise<OllamaStatus>;
  ollamaStart(): Promise<string>;
  ollamaStop(): Promise<void>;
  ollamaDownload(): Promise<void>;
  ollamaPull(model: string): Promise<void>;
  ollamaCancel(model: string): Promise<void>;
  ollamaDelete(model: string): Promise<void>;
  ollamaUnload(model: string): Promise<void>;
  ollamaSetDefault(model: string): Promise<void>;
  ollamaUseForBot(bot: string, model: string | null): Promise<void>;
  onPullProgress(cb: (p: PullProgress) => void): () => void;
  onEvent(cb: (e: AgentEvent) => void): () => void;
  onApprovalRequest(cb: (r: ApprovalRequest) => void): () => void;
}
