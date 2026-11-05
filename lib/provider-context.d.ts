/** Provider author boundary v1; independent from Plugin/Adapter v0 and persistent Task formats. */
export const PROVIDER_FACTORY_CONTEXT_VERSION: 1;
export type ProviderCapability = 'image' | 'video' | 'tts' | 'music' | 'transcribe';
export type ProviderMethod = 'discover' | 'submit' | 'poll' | 'cancel' | 'download' | 'mapError';
export type ProviderAcceptance = 'not_accepted' | 'accepted' | 'unknown';
export type ProviderStage = 'validate' | 'prepare' | 'upload' | 'submit' | 'response' | 'poll' | 'cancel' | 'download' | 'persist' | 'emit';
export type ProviderErrorCategory = 'invalid_request' | 'authentication' | 'quota' | 'rate_limit' | 'network' | 'timeout' | 'aborted' | 'provider' | 'protocol' | 'local_io' | 'unknown';
export interface ProviderErrorRecord {
  readonly stage: ProviderStage;
  readonly category: ProviderErrorCategory;
  readonly acceptance: ProviderAcceptance;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly httpStatus?: number;
  readonly providerCode?: string;
}
export interface ProviderNetwork {
  /** Borrowed Core port: only inside an awaited lifecycle method, including all body reads and child requests. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}
export interface ProviderFactoryContext {
  readonly contractVersion: 1;
  readonly network: Readonly<ProviderNetwork>;
  /** Selected raw model ID when Core is resolving an existing Task. */
  readonly modelId?: string;
}
export interface ProviderConnection {
  readonly id: string;
  readonly baseUrl?: string;
  readonly mediaBaseUrl?: string;
  /** Runtime value resolved by Core. Never persist the connection or read another credential source. */
  readonly apiKey?: string;
  readonly auth?: string;
  readonly [field: string]: unknown;
}
export interface ProviderOperationContext {
  readonly signal?: AbortSignal;
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly modelRef?: string;
  readonly providerId?: string;
  readonly attempt?: Readonly<{ id: string; ordinal: number; providerId: string; model: string }>;
}
export interface ProviderImageInput { readonly bytes: Uint8Array; readonly mediaType: string; }
export interface ProviderSubmitRequest {
  readonly capability: ProviderCapability;
  /** Raw supplier model ID, never providerId::modelId. */
  readonly model: string;
  readonly input: Readonly<Record<string, unknown> & { image?: ProviderImageInput }>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export type ProviderArtifact = Readonly<{ kind: 'remote-url'; url: string; mediaType?: string }>
  | Readonly<{ kind: 'inline-base64'; data: string; mediaType?: string }>;
export type ProviderSubmissionResult = Readonly<{ kind: 'accepted'; remoteTaskId: string }>
  | Readonly<{ kind: 'completed'; artifacts: readonly ProviderArtifact[]; value?: unknown }>
  | Readonly<{ kind: 'not_accepted' | 'acceptance_unknown'; error: Error | Partial<ProviderErrorRecord> }>;
export interface ProviderRemoteRequest {
  readonly capability: ProviderCapability;
  readonly remoteTaskId: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export type ProviderPollResult = Readonly<{ kind: 'pending'; progress?: string }>
  | Readonly<{ kind: 'succeeded'; artifacts: readonly ProviderArtifact[]; value?: unknown }>
  | Readonly<{ kind: 'failed' | 'canceled' | 'unknown'; error?: Error | Partial<ProviderErrorRecord>; message?: string }>;
export type ProviderCancelResult = Readonly<{ kind: 'canceled' }>
  | Readonly<{ kind: 'not_supported'; reason?: string }>
  | Readonly<{ kind: 'unknown'; error?: Error | Partial<ProviderErrorRecord>; message?: string }>;
export interface ProviderDownloadRequest {
  readonly capability: ProviderCapability;
  readonly artifact: ProviderArtifact;
  /** Core-owned staging path; write only this new file, never Core metadata or another root. */
  readonly targetPath: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
export interface ProviderDiscoveryRequest { readonly signal?: AbortSignal; readonly timeoutMs?: number; }
export interface ProviderDiscoveryResult {
  readonly models: readonly (string | Readonly<{ id: string; capabilities?: readonly string[] }>)[];
}
export interface ProviderOperations {
  submit(request: ProviderSubmitRequest, context: ProviderOperationContext): ProviderSubmissionResult | Promise<ProviderSubmissionResult>;
  /** Synchronous. The any input retains v0 identity mappers; returned records are normalized by Core. */
  mapError(error: any, context: Partial<ProviderErrorRecord>): Error | Partial<ProviderErrorRecord> | undefined;
  discover?(request: ProviderDiscoveryRequest, context: ProviderOperationContext): ProviderDiscoveryResult | Promise<ProviderDiscoveryResult>;
  poll?(request: ProviderRemoteRequest, context: ProviderOperationContext): ProviderPollResult | Promise<ProviderPollResult>;
  cancel?(request: ProviderRemoteRequest, context: ProviderOperationContext): ProviderCancelResult | Promise<ProviderCancelResult>;
  download?(request: ProviderDownloadRequest, context: ProviderOperationContext): Readonly<{ bytes: number }> | Promise<Readonly<{ bytes: number }>>;
}
