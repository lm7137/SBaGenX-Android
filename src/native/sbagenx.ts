import { NativeModules, Platform } from 'react-native';

export type DocumentKind = 'sbg' | 'sbgf';

export type SbaGenXDiagnostic = {
  severity: 'error' | 'warning';
  code: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
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
};

type NativeSbaGenXModule = {
  getBridgeInfo(): Promise<string>;
  validateSbg(text: string, sourceName?: string): Promise<string>;
  validateSbgf(text: string, sourceName?: string): Promise<string>;
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
