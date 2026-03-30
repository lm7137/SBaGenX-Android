import { NativeModules, Platform } from 'react-native';

export type DocumentKind = 'sbg' | 'sbgf';
export type ProgramKind = 'drop' | 'sigmoid' | 'slide' | 'curve';

export type SbaGenXDiagnostic = {
  severity: 'error' | 'warning';
  code: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
};

export type CurveParameter = {
  name: string;
  value: number;
};

export type CurveInfo = {
  parameterCount: number;
  hasSolve: boolean;
  hasCarrierExpr: boolean;
  hasAmpExpr: boolean;
  hasMixampExpr: boolean;
  beatPieceCount: number;
  carrierPieceCount: number;
  ampPieceCount: number;
  mixampPieceCount: number;
  parameters: CurveParameter[];
};

export type BridgeInfo = {
  bridgeVersion: string;
  libraryVersion: string;
  apiVersion: number;
};

export type ValidationResult = {
  status: number;
  statusText: string;
  diagnosticCount: number;
  diagnostics: SbaGenXDiagnostic[];
  curveInfo?: CurveInfo | null;
};

export type ContextState = {
  status: number;
  statusText: string;
  prepared: boolean;
  sampleRate: number;
  channels: number;
  timeSec: number;
  durationSec: number;
  sourceName: string;
  mixActive?: boolean;
  mixLooping?: boolean;
  mixPath?: string;
  mixSourceName?: string;
  error: string;
};

export type RenderPreviewResult = ContextState & {
  frameCount: number;
  sampleValueCount: number;
  peakAbs: number;
  rms: number;
  samples: number[];
};

export type PlaybackState = {
  status: number;
  statusText: string;
  prepared: boolean;
  active: boolean;
  sampleRate: number;
  channels: number;
  bufferFrames: number;
  timeSec: number;
  durationSec: number;
  sourceName: string;
  mixActive?: boolean;
  mixLooping?: boolean;
  mixPath?: string;
  mixSourceName?: string;
  lastError: string;
};

export type SavedDocumentSummary = {
  name: string;
  sizeBytes: number;
  modifiedAtMs: number;
  sourceName?: string;
};

export type LoadedDocument = SavedDocumentSummary & {
  text: string;
};

export type DocumentStoreInfo = {
  mode: 'sandbox' | 'library';
  label: string;
  treeUri: string;
  portableDocumentStorage: boolean;
};

export type PickedMixInput = {
  uri: string;
  displayName: string;
};

export type ProgramRuntimeRequest = {
  programKind: ProgramKind;
  mainArg: string;
  dropTimeSec: number;
  holdTimeSec: number;
  wakeTimeSec: number;
  curveText?: string | null;
  sourceName?: string;
  mixPath?: string | null;
};

type NativeSbaGenXModule = {
  getBridgeInfo(): Promise<string>;
  validateSbg(text: string, sourceName?: string): Promise<string>;
  validateSbgf(text: string, sourceName?: string): Promise<string>;
  prepareSbgContext(text: string, sourceName?: string): Promise<string>;
  prepareProgramContext(
    programKind: ProgramKind,
    mainArg: string,
    dropTimeSec: number,
    holdTimeSec: number,
    wakeTimeSec: number,
    curveText?: string | null,
    sourceName?: string,
    mixPath?: string | null,
  ): Promise<string>;
  getContextState(): Promise<string>;
  renderPreview(frameCount: number, sampleValueCount: number): Promise<string>;
  resetContext(): Promise<string>;
  startPlayback(text: string, sourceName?: string): Promise<string>;
  startProgramPlayback(
    programKind: ProgramKind,
    mainArg: string,
    dropTimeSec: number,
    holdTimeSec: number,
    wakeTimeSec: number,
    curveText?: string | null,
    sourceName?: string,
    mixPath?: string | null,
  ): Promise<string>;
  stopPlayback(): Promise<string>;
  getPlaybackState(): Promise<string>;
  listDocuments(): Promise<string>;
  getDocumentStoreInfo(): Promise<string>;
  saveDocument(name: string, text: string): Promise<string>;
  loadDocument(name: string): Promise<string>;
  pickLibraryFolder(): Promise<string>;
  pickDocumentToLoad(): Promise<string | null>;
  pickMixInput(): Promise<string | null>;
};

const nativeModule = NativeModules.SbaGenXModule as
  | NativeSbaGenXModule
  | undefined;

function requireNativeModule(): NativeSbaGenXModule {
  if (!nativeModule) {
    throw new Error(`SbaGenX native module is unavailable on ${Platform.OS}.`);
  }

  return nativeModule;
}

async function parseNativeJson<T>(jsonPromise: Promise<string>): Promise<T> {
  return JSON.parse(await jsonPromise) as T;
}

export function isNativeBridgeAvailable(): boolean {
  return nativeModule != null;
}

export function ensureDocumentName(name: string, kind: DocumentKind): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return `untitled.${kind}`;
  }

  return /\.[^./\\]+$/u.test(trimmed) ? trimmed : `${trimmed}.${kind}`;
}

export function inferDocumentKind(name: string): DocumentKind {
  return name.toLowerCase().endsWith('.sbgf') ? 'sbgf' : 'sbg';
}

export async function getBridgeInfo(): Promise<BridgeInfo> {
  return parseNativeJson<BridgeInfo>(requireNativeModule().getBridgeInfo());
}

export async function validateDocument(
  kind: DocumentKind,
  text: string,
  sourceName?: string,
): Promise<ValidationResult> {
  const module = requireNativeModule();
  const fallbackSource = kind === 'sbg' ? 'scratch.sbg' : 'scratch.sbgf';

  return parseNativeJson<ValidationResult>(
    kind === 'sbg'
      ? module.validateSbg(text, sourceName ?? fallbackSource)
      : module.validateSbgf(text, sourceName ?? fallbackSource),
  );
}

export async function prepareSbgContext(
  text: string,
  sourceName?: string,
): Promise<ContextState> {
  return parseNativeJson<ContextState>(
    requireNativeModule().prepareSbgContext(text, sourceName ?? 'scratch.sbg'),
  );
}

export async function getContextState(): Promise<ContextState> {
  return parseNativeJson<ContextState>(requireNativeModule().getContextState());
}

export async function prepareProgramContext(
  request: ProgramRuntimeRequest,
): Promise<ContextState> {
  return parseNativeJson<ContextState>(
    requireNativeModule().prepareProgramContext(
      request.programKind,
      request.mainArg,
      request.dropTimeSec,
      request.holdTimeSec,
      request.wakeTimeSec,
      request.curveText ?? null,
      request.sourceName ?? `program:${request.programKind}`,
      request.mixPath ?? null,
    ),
  );
}

export async function renderPreview(
  frameCount: number,
  sampleValueCount: number,
): Promise<RenderPreviewResult> {
  return parseNativeJson<RenderPreviewResult>(
    requireNativeModule().renderPreview(frameCount, sampleValueCount),
  );
}

export async function resetContext(): Promise<ContextState> {
  return parseNativeJson<ContextState>(requireNativeModule().resetContext());
}

export async function startPlayback(
  text: string,
  sourceName?: string,
): Promise<PlaybackState> {
  return parseNativeJson<PlaybackState>(
    requireNativeModule().startPlayback(text, sourceName ?? 'scratch.sbg'),
  );
}

export async function startProgramPlayback(
  request: ProgramRuntimeRequest,
): Promise<PlaybackState> {
  return parseNativeJson<PlaybackState>(
    requireNativeModule().startProgramPlayback(
      request.programKind,
      request.mainArg,
      request.dropTimeSec,
      request.holdTimeSec,
      request.wakeTimeSec,
      request.curveText ?? null,
      request.sourceName ?? `program:${request.programKind}`,
      request.mixPath ?? null,
    ),
  );
}

export async function stopPlayback(): Promise<PlaybackState> {
  return parseNativeJson<PlaybackState>(requireNativeModule().stopPlayback());
}

export async function getPlaybackState(): Promise<PlaybackState> {
  return parseNativeJson<PlaybackState>(
    requireNativeModule().getPlaybackState(),
  );
}

export async function listDocuments(): Promise<SavedDocumentSummary[]> {
  return parseNativeJson<SavedDocumentSummary[]>(
    requireNativeModule().listDocuments(),
  );
}

export async function getDocumentStoreInfo(): Promise<DocumentStoreInfo> {
  return parseNativeJson<DocumentStoreInfo>(
    requireNativeModule().getDocumentStoreInfo(),
  );
}

export async function saveDocument(
  name: string,
  text: string,
): Promise<SavedDocumentSummary> {
  return parseNativeJson<SavedDocumentSummary>(
    requireNativeModule().saveDocument(name, text),
  );
}

export async function loadDocument(name: string): Promise<LoadedDocument> {
  return parseNativeJson<LoadedDocument>(
    requireNativeModule().loadDocument(name),
  );
}

export async function pickDocumentToLoad(): Promise<LoadedDocument | null> {
  const picked = await requireNativeModule().pickDocumentToLoad();
  return picked ? (JSON.parse(picked) as LoadedDocument) : null;
}

export async function pickLibraryFolder(): Promise<DocumentStoreInfo> {
  return parseNativeJson<DocumentStoreInfo>(
    requireNativeModule().pickLibraryFolder(),
  );
}

export async function pickMixInput(): Promise<PickedMixInput | null> {
  const picked = await requireNativeModule().pickMixInput();
  if (!picked) {
    return null;
  }
  return JSON.parse(picked) as PickedMixInput;
}
