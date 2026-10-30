/** Experimental v0. Trusted local code; no sandbox, discovery, installation or implicit grant. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type PluginKind = 'providers' | 'operations' | 'pages' | 'renderers' | 'settings';
export const PLUGIN_CONTRACT_VERSION: 0;
export const PLUGIN_KINDS: readonly PluginKind[];
export type PluginCoreCommand = 'artifact.inspect' | 'artifact.read' | 'artifact.list' | 'task.inspect' | 'task.list' | 'artifact.import';
export const PLUGIN_CORE_COMMANDS: Readonly<Record<PluginCoreCommand, 'reader' | 'writer'>>;
export class PluginContractError extends Error { constructor(code: string, message: string); readonly code: string; }
export interface PluginDependency {
  readonly contractVersion: 0;
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly kind: PluginKind;
  /** Fully qualified pluginId.localId. */
  readonly contributionId: string;
  readonly contributionVersion: string;
}
export interface Contribution { readonly id: string; readonly version: string; readonly title: string; }
export interface ProviderContribution extends Contribution {
  readonly capabilities: readonly ('image-gen' | 'video-gen' | 'tts' | 'music-gen' | 'transcribe')[];
  readonly configuration?: readonly { key: 'baseUrl' | 'mediaBaseUrl' | 'apiKey'; label: string; type: 'url' | 'secret'; required?: boolean; advanced?: boolean }[];
}
export interface OperationContribution extends Contribution {
  readonly mode: 'reader' | 'writer';
  readonly commands: readonly PluginCoreCommand[];
  /** Top-level string or string-array input fields containing source Artifact IDs. Bound at acceptance. */
  readonly artifactInputs?: readonly string[];
  /** Closed root object; supported JSON Schema subset documented in PLUGINS.md. */
  readonly inputSchema: { readonly type: 'object'; readonly additionalProperties: false; readonly [key: string]: JsonValue };
}
export interface PageContribution extends Contribution {
  /** Plugin-relative bundled JS/MJS module. Explicit entry loader pins it before Panel selection. */
  readonly entry: string;
  readonly styles?: readonly string[];
}
export interface RendererContribution extends PageContribution { readonly mediaTypes: readonly string[]; }
export interface SettingsContribution extends PageContribution {}
export interface PluginPanelSelection {
  readonly pages?: readonly string[];
  readonly settings?: readonly string[];
  readonly renderers?: readonly string[];
}
export interface PluginManifest {
  readonly contractVersion: 0;
  readonly id: string;
  readonly version: string;
  /** SemVer precedence interval, min inclusive/maxExclusive exclusive. Not npm range syntax. */
  readonly compatibility: { readonly min: string; readonly maxExclusive: string };
  readonly contributions: {
    readonly providers?: readonly ProviderContribution[];
    readonly operations?: readonly OperationContribution[];
    readonly pages?: readonly PageContribution[];
    readonly renderers?: readonly RendererContribution[];
    readonly settings?: readonly SettingsContribution[];
  };
}
export interface PluginOperationContext {
  readonly signal: AbortSignal;
  readonly dependency: PluginDependency;
  readonly core: { execute(command: PluginCoreCommand, input: Record<string, unknown>): Promise<unknown> };
}
export type PluginOperation = (input: Readonly<Record<string, JsonValue>>, context: PluginOperationContext) => JsonValue | Promise<JsonValue>;
export type ProviderCapability = 'image' | 'video' | 'tts' | 'music' | 'transcribe';
export type ProviderMethod = 'discover' | 'submit' | 'poll' | 'cancel' | 'download' | 'mapError';
export interface ProviderAdapterInput {
  id: string; protocol: string; capabilities: ProviderCapability[]; contractVersion?: 0;
  operations: Partial<Record<ProviderMethod, (...args: any[]) => unknown>>;
  unsupported?: Partial<Record<ProviderMethod, string>>;
  prepareInput?: (...args: any[]) => unknown;
  unsupportedPreparation?: string;
  pluginDependency?: PluginDependency;
}
export type ProviderAdapter = Readonly<Omit<ProviderAdapterInput, 'contractVersion' | 'capabilities' | 'operations' | 'unsupported'> & {
  contractVersion: 0;
  capabilities: readonly ProviderCapability[];
  operations: Readonly<Partial<Record<ProviderMethod, (...args: any[]) => unknown>>>;
  unsupported: Readonly<Partial<Record<ProviderMethod, { readonly reason: string }>>>;
}>;
export function defineProviderAdapter(input: ProviderAdapterInput): ProviderAdapter;
export function normalizeMediaEndpoint(value: string): string;
export interface ProviderImplementation {
  normalizeEndpoint(value: string): string;
  createAdapter(provider: Record<string, any>, options?: Record<string, any>): ProviderAdapter;
  supportsModel?(input: { provider: Record<string, unknown>; modelId: string; capability: string; checkEndpoint?: boolean }): boolean;
  supportsImageEdit?(modelId: string): boolean;
}
export interface PluginActivationContext {
  readonly coreVersion: string;
  readonly plugin: { readonly id: string; readonly version: string };
  /** Register during activate, including before awaited initialization; reverse order cleanup. */
  onDispose(cleanup: () => void | Promise<void>): void;
}
export interface PluginImplementation {
  readonly providers?: Readonly<Record<string, ProviderImplementation>>;
  readonly operations?: Readonly<Record<string, PluginOperation>>;
}
export interface CorePlugin {
  readonly manifest: PluginManifest;
  activate(context: PluginActivationContext): PluginImplementation | Promise<PluginImplementation>;
}
export function definePlugin(definition: CorePlugin): CorePlugin;
export interface ProviderRegistry {
  descriptor(id: string): Readonly<Record<string, any>> | undefined;
  snapshot(): { state: string; protocols: Record<string, any>[]; extensions: { id: string; version: string }[]; activeCalls: number; cleanupFailed: boolean; contractVersion: 0 };
  createAdapter(id: string, provider: Record<string, any>, options?: Record<string, any>): ProviderAdapter;
  dispose(): Promise<void>;
}
export interface CorePluginRegistry {
  readonly providers: ProviderRegistry;
  snapshot(): {
    contractVersion: 0; coreVersion: string; state: string; activeCalls: number; cleanupFailed: boolean;
    plugins: PluginManifest[];
    contributions: {
      providers: (ProviderContribution & { dependency: PluginDependency })[];
      operations: (OperationContribution & { dependency: PluginDependency })[];
      pages: (PageContribution & { dependency: PluginDependency })[];
      renderers: (RendererContribution & { dependency: PluginDependency })[];
      settings: (SettingsContribution & { dependency: PluginDependency })[];
    };
  };
  dependency(kind: PluginKind, qualifiedId: string): PluginDependency;
  assertDependency(dependency: PluginDependency): PluginDependency;
  dispose(): Promise<void>;
}
export function createCorePluginRegistry(options?: { plugins?: CorePlugin[]; coreVersion?: string }): Promise<CorePluginRegistry>;
export function loadCorePluginRegistry(options?: { entries?: string[]; coreVersion?: string }): Promise<CorePluginRegistry>;
export type CoreCapabilityScope = 'read' | 'create' | 'execute' | 'stop';
export type CoreBridgeCapability = 'image-edit' | 'image-generate' | 'tts' | 'transcribe';
export interface ContributionAccess {
  readonly local: 'requires-configuration' | 'requires-grant' | 'descriptor-only' | 'unavailable';
  readonly web: 'via-media-flow' | 'via-operation' | 'not-exposed' | 'durable-operation-required' | 'not-mounted' | 'available-in-panel' | 'unavailable';
  readonly mcp: 'via-media-flow' | 'requires-selection' | 'not-exposed' | 'durable-operation-required' | 'not-applicable' | 'unavailable';
}
export interface CatalogContribution extends Contribution {
  readonly dependency: PluginDependency;
  /** Declaration/assembly facts only; never the caller's authorization or service health. */
  readonly access: ContributionAccess;
}
export interface CoreCapabilitySnapshot {
  readonly contractVersion: 0;
  readonly state: string;
  readonly coreVersion?: string;
  readonly scopeOptions: readonly { readonly id: CoreCapabilityScope; readonly title: string }[];
  readonly controlTools: readonly string[];
  readonly groups: readonly {
    readonly id: CoreBridgeCapability; readonly recipe: string; readonly title: string; readonly label: string; readonly shortTitle: string;
    readonly media: string; readonly requiresAudio?: boolean; readonly tools: readonly string[];
  }[];
  readonly tools: readonly { readonly name: string; readonly scope: CoreCapabilityScope; readonly description: string }[];
  readonly pluginTools: CoreCapabilitySnapshot['tools'];
  readonly pluginControlTools: readonly string[];
  readonly media: readonly { readonly id: string; readonly title: string; readonly note?: string; readonly capabilities: readonly CoreBridgeCapability[] }[];
  readonly plugins: readonly { readonly id: string; readonly version: string; readonly compatibility: PluginManifest['compatibility'] }[];
  readonly contributions: {
    readonly providers: readonly (ProviderContribution & CatalogContribution)[];
    readonly operations: readonly (OperationContribution & CatalogContribution)[];
    /** No browser module path is exposed or mounted by discovery. */
    readonly pages: readonly CatalogContribution[];
    readonly renderers: readonly (CatalogContribution & { readonly mediaTypes: readonly string[] })[];
    readonly settings: readonly CatalogContribution[];
  };
}
export interface CoreCapabilityCatalog {
  snapshot(options?: { audioEnabled?: boolean; panelContributions?: PluginPanelSelection; allowedOperations?: readonly string[] }): CoreCapabilitySnapshot;
  /** Validate an explicit local selection. Does not invoke, persist a grant or enable MCP/Web. */
  selectOperations(ids?: readonly string[]): readonly (OperationContribution & CatalogContribution)[];
}
export function createCoreCapabilityCatalog(options?: { registry?: CorePluginRegistry }): CoreCapabilityCatalog;
export interface CorePluginHost {
  call(id: string, input: Record<string, JsonValue>, options?: { dependency?: PluginDependency; signal?: AbortSignal }): Promise<{ dependency: PluginDependency; value: JsonValue }>;
  snapshot(): { state: string; queuedWrites: number; activeWrites: number; activeReaders: number; cleanupFailed: boolean };
  /** Caller disposes the shared registry after every host has closed. */
  dispose(): Promise<ReturnType<CorePluginHost['snapshot']>>;
}
export function createCorePluginHost(options: { dataRoot: string; registry: CorePluginRegistry; allowedOperations?: string[] }): CorePluginHost;
export interface CorePluginWorkbenchSnapshot {
  readonly contractVersion: 0;
  readonly state: string;
  readonly origin: string | null;
  /** Media writes remain disabled; optional Provider editing has a separate owner gate. */
  readonly readOnly: true;
  readonly activeReads: number;
  readonly cleanupFailed?: boolean;
}
export interface CorePluginWorkbench {
  start(options?: { port?: number }): Promise<{ readonly origin: string; readonly accessToken: string; readonly loginUrl: string; readonly loginExpiresAt: string }>;
  snapshot(): CorePluginWorkbenchSnapshot;
  readonly closed: Promise<CorePluginWorkbenchSnapshot>;
  dispose(): Promise<CorePluginWorkbenchSnapshot>;
}
export interface CorePasswordPluginWorkbench extends Omit<CorePluginWorkbench, 'start'> {
  start(options?: { port?: number }): Promise<{ readonly origin: string; readonly accessToken: string; readonly loginUrl: string;
    readonly authentication: { readonly mode: 'password'; readonly configured: boolean; readonly authId: string;
      readonly rememberDays: 30; readonly minPasswordLength: 8; readonly maxPasswordLength: 128 } }>;
}
export interface CorePluginWorkbenchOptions {
  dataRoot: string; registry?: CorePluginRegistry; panelContributions?: PluginPanelSelection;
  panelManifestPath?: string; providerConfigPath?: string; allowProviderManagement?: boolean;
  /** Omitted: no business runner. []: reconcile/read history only. IDs: explicitly enabled durable businesses. */
  allowedOperations?: string[];
  /** Explicit private directory outside dataRoot. Enables owner connection management. */
  connectionStore?: string;
  /** Enable the standard HTTP /mcp edge. Does not start a second Core. */
  allowMcp?: boolean;
  /** Optional persistent browser password/session store, in a private directory outside dataRoot. */
  workbenchAuth?: { directory: string };
}
export function createCorePluginWorkbench(options: CorePluginWorkbenchOptions & { workbenchAuth: { directory: string } }): CorePasswordPluginWorkbench;
export function createCorePluginWorkbench(options: Omit<CorePluginWorkbenchOptions, 'workbenchAuth'> & { workbenchAuth?: undefined }): CorePluginWorkbench;
export function createCorePluginWorkbench(options: CorePluginWorkbenchOptions): CorePluginWorkbench | CorePasswordPluginWorkbench;
export function checkedPluginDependency(value: unknown): PluginDependency;
export function comparePluginVersions(a: string, b: string): -1 | 0 | 1;

export interface PluginTheme { readonly mode: 'light' | 'dark'; readonly density: string; readonly accent: 'iris'; }
export interface PluginWebSession {
  readonly contractVersion: 0;
  readonly instanceId: string;
  readonly rootId?: string | null;
  readonly operations: readonly string[];
  readonly readOnly: boolean;
  readonly audio: boolean;
  readonly providerManagement: boolean;
  readonly pluginExecution: boolean;
  readonly pluginOperations: readonly PluginDependency[];
}
export interface PluginArtifact { readonly id: string; readonly mediaType: string; readonly label?: string; }
export interface PluginWebRequestOptions { readonly signal?: AbortSignal; }
export interface PluginBusinessRequest {
  readonly key: string;
  readonly operationId: string;
  readonly dependency: PluginDependency;
  readonly input: Readonly<Record<string, JsonValue>>;
}
export interface PluginDurableOperation {
  readonly contractVersion: 0;
  readonly id: string;
  readonly rootId: string;
  readonly action: 'plugin.execute';
  readonly operationId: string;
  readonly dependency: PluginDependency;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly inputDigest: string;
  readonly sourceArtifactIds: readonly string[];
  readonly revision: number;
  readonly state: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly failureCode?: 'dependency_unavailable' | 'permission_denied' | 'execution_failed';
  readonly result?: { readonly value: JsonValue; readonly artifactIds: readonly string[] };
}
export interface PluginWebApi {
  runs(query?: Readonly<Record<string, string>>, options?: PluginWebRequestOptions): Promise<JsonValue>;
  run(id: string, options?: PluginWebRequestOptions): Promise<JsonValue>;
  models(options?: PluginWebRequestOptions): Promise<JsonValue>;
  audioModels(options?: PluginWebRequestOptions): Promise<JsonValue>;
  artifact(artifact: PluginArtifact, options?: PluginWebRequestOptions): Promise<Blob>;
  /** Only settings mounts in an explicitly enabled owner Provider-management session. */
  readonly providers?: {
    read(options?: PluginWebRequestOptions): Promise<JsonValue>;
    save(input: Record<string, JsonValue>, options?: PluginWebRequestOptions): Promise<JsonValue>;
  };
  /** Present only when the service explicitly owns a durable plugin runner. Core checks each request. */
  readonly pluginOperations?: {
    catalog(query?: Readonly<Record<string, string>>, options?: PluginWebRequestOptions): Promise<JsonValue>;
    history(options?: PluginWebRequestOptions): Promise<JsonValue>;
    execute(input: PluginBusinessRequest, options?: PluginWebRequestOptions): Promise<{ contractVersion: 0; operation: PluginDurableOperation; idempotentReplay: boolean }>;
    inspect(id: string, options?: PluginWebRequestOptions): Promise<JsonValue>;
    lookup(key: string, options?: PluginWebRequestOptions): Promise<JsonValue>;
    stop(id: string, options?: PluginWebRequestOptions): Promise<JsonValue>;
  };
}
/** Same-origin trusted modules; Shadow DOM is a style boundary, not a security sandbox. */
export interface PluginWebContext<Container = unknown> {
  readonly container: Container;
  readonly signal: AbortSignal;
  readonly dependency: PluginDependency;
  readonly session: PluginWebSession;
  readonly api: PluginWebApi;
  readonly theme: { current(): PluginTheme; subscribe(listener: (theme: PluginTheme) => void): () => void };
}
export interface PluginPageModule<Container = unknown> { mount(context: PluginWebContext<Container>): void | (() => void) | Promise<void | (() => void)>; }
export interface PluginSettingsModule<Container = unknown> extends PluginPageModule<Container> {}
export interface PluginRendererModule<Container = unknown> {
  mount(context: PluginWebContext<Container> & { readonly artifact: PluginArtifact }): void | (() => void) | Promise<void | (() => void)>;
}
