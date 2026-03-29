import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ensureDocumentName,
  getBridgeInfo,
  getContextState,
  getDocumentStoreInfo,
  getPlaybackState,
  inferDocumentKind,
  isNativeBridgeAvailable,
  listDocuments,
  loadDocument,
  pickLibraryFolder,
  pickMixInput,
  prepareSbgContext,
  renderPreview,
  saveDocument,
  startPlayback,
  stopPlayback,
    type BridgeInfo,
    type ContextState,
    type CurveInfo,
    type DocumentStoreInfo,
    type DocumentKind,
    type PlaybackState,
  type RenderPreviewResult,
  type SavedDocumentSummary,
  type SbaGenXDiagnostic,
  validateDocument,
} from '../native/sbagenx';
import { SbaGenXEditor } from './SbaGenXEditor';
import { WebsiteBackdrop } from './WebsiteBackdrop';

const brandIcon = require('../assets/sbagenx-icon.png');
const heroBlueOrb = require('../assets/hero-blue-orb.png');
const heroPinkOrb = require('../assets/hero-pink-orb.png');

const SURFACE_SOFT = 'rgba(224, 224, 216, 0.96)';
const SURFACE_GLASS = SURFACE_SOFT;
const SURFACE_BORDER = SURFACE_SOFT;
const SURFACE_BORDER_LIGHT = SURFACE_SOFT;

const DEFAULT_SBG_NAME = 'examples/plus/deep-sleep-aid.sbg';
const DEFAULT_SBGF_NAME = 'examples/basics/curve-expfit-solve-demo.sbgf';

const VALID_SBG_SAMPLE =
  '## Deep Sleep Aid - 45 minutes\n' +
  '## Gradually transitions from alpha to delta to help you fall asleep\n\n' +
  '-SE\n\n' +
  '# Define tone sets\n' +
  'ts-relax: brown/60 300+10/15\n' +
  'ts-drowsy: brown/60 200+7/20\n' +
  'ts-sleep: brown/70 100+3/25\n' +
  'ts-deep-sleep: brown/70 100+1.5/20\n' +
  'off: -\n\n' +
  '# Timeline\n' +
  '00:00:00 off ->\n' +
  '00:00:15 ts-relax\n' +
  '00:09:00 ts-relax ->\n' +
  '00:10:00 ts-drowsy\n' +
  '00:19:00 ts-drowsy ->\n' +
  '00:20:00 ts-sleep\n' +
  '00:29:00 ts-sleep ->\n' +
  '00:30:00 ts-deep-sleep\n' +
  '00:44:00 ts-deep-sleep ->\n' +
  '00:45:00 off\n';

const INVALID_SBG_SAMPLE = '-SE\n-Z nope\n\nalloff: -\n\nNOW alloff\n';

const VALID_SBGF_SAMPLE =
  '# SBaGenX custom curve example (.sbgf)\n' +
  '# Exponential beat curve with constants solved from boundary conditions.\n' +
  '#\n' +
  '# Usage example:\n' +
  '#   sbagenx -P -p curve examples/basics/curve-expfit-solve-demo.sbgf 00ls:l=0.15\n\n' +
  'param l = 0.15\n' +
  'solve A,C : A*exp(-l*0)+C=b0 ; A*exp(-l*D)+C=b1\n\n' +
  'beat = A*exp(-l*m) + C\n' +
  'carrier = c0 + (c1-c0) * ramp(m,0,T)\n';

const INVALID_SBGF_SAMPLE = 'title "broken"\nbeat =\n';

const DOCUMENT_PRESETS: Record<
  DocumentKind,
  {
    sample: string;
    sampleName: string;
    broken: string;
    brokenName: string;
  }
> = {
  sbg: {
    sample: VALID_SBG_SAMPLE,
    sampleName: DEFAULT_SBG_NAME,
    broken: INVALID_SBG_SAMPLE,
    brokenName: 'scratch.sbg',
  },
  sbgf: {
    sample: VALID_SBGF_SAMPLE,
    sampleName: DEFAULT_SBGF_NAME,
    broken: INVALID_SBGF_SAMPLE,
    brokenName: 'scratch.sbgf',
  },
};

type ActionTone = 'primary' | 'ghost';

type ActionButtonProps = {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  tone?: ActionTone;
};

type MetricCardProps = {
  label: string;
  value: string;
};

type DocumentBrowserDirectoryEntry = {
  kind: 'directory';
  name: string;
  path: string;
};

type DocumentBrowserFileEntry = {
  kind: 'file';
  name: string;
  path: string;
  document: SavedDocumentSummary;
};

type DocumentBrowserEntry =
  | DocumentBrowserDirectoryEntry
  | DocumentBrowserFileEntry;

function formatSpan(diagnostic: SbaGenXDiagnostic): string {
  return `${diagnostic.line}:${diagnostic.column} -> ${diagnostic.endLine}:${diagnostic.endColumn}`;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }

  return `${(value / 1024).toFixed(1)} KB`;
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

function formatCurveValue(value: number): string {
  return Math.abs(value) >= 10 ? value.toFixed(3) : value.toFixed(4);
}

function isPreambleCommentOrBlank(line: string): boolean {
  const trimmed = line.trim();
  return !trimmed || trimmed.startsWith('#');
}

function findOptionBlockRange(lines: string[]): { start: number; end: number } | null {
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (isPreambleCommentOrBlank(lines[index])) {
      continue;
    }

    if (!trimmed.startsWith('-')) {
      return null;
    }

    start = index;
    break;
  }

  if (start < 0) {
    return null;
  }

  let end = start;
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      end = index;
      continue;
    }
    if (!trimmed.startsWith('-')) {
      break;
    }
    end = index;
  }

  return { start, end };
}

function extractMixPathFromOptionLine(line: string): string | null {
  const match = /(?:^|\s)-m\s+(\S+)/u.exec(line);
  return match?.[1] ?? null;
}

function findSafePreambleMixPath(text: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const optionBlock = findOptionBlockRange(lines);
  if (!optionBlock) {
    return null;
  }

  for (let index = optionBlock.start; index <= optionBlock.end; index += 1) {
    const mixPath = extractMixPathFromOptionLine(lines[index]);
    if (mixPath) {
      return mixPath;
    }
  }

  return null;
}

function upsertSafePreambleMixPath(text: string, mixPath: string): string {
  const normalizedText = text.replace(/\r\n/g, '\n');
  const lines = normalizedText.split('\n');
  const optionBlock = findOptionBlockRange(lines);

  if (!optionBlock) {
    return ['-SE', `-m ${mixPath}`, '', normalizedText].join('\n');
  }

  for (let index = optionBlock.start; index <= optionBlock.end; index += 1) {
    if (extractMixPathFromOptionLine(lines[index])) {
      lines[index] = lines[index].replace(
        /(^|\s)-m\s+\S+/u,
        match => match.replace(/-m\s+\S+/u, `-m ${mixPath}`),
      );
      return lines.join('\n');
    }
  }

  lines.splice(optionBlock.end + 1, 0, `-m ${mixPath}`);
  return lines.join('\n');
}

function summarizeMixReference(mixPath: string): string {
  const trimmed = mixPath.trim();
  if (!trimmed) {
    return '';
  }

  const lastSlash = trimmed.lastIndexOf('/');
  const candidate = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;

  try {
    return decodeURIComponent(candidate) || trimmed;
  } catch {
    return candidate || trimmed;
  }
}

function parentDocumentDirectory(path: string): string | null {
  if (!path) {
    return null;
  }

  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 1) {
    return '';
  }

  return segments.slice(0, -1).join('/');
}

function listDocumentBrowserEntries(
  documents: SavedDocumentSummary[],
  directoryPath: string,
): DocumentBrowserEntry[] {
  const normalizedDirectory = directoryPath.trim().replace(/^\/+|\/+$/g, '');
  const prefix = normalizedDirectory ? `${normalizedDirectory}/` : '';
  const directories = new Map<string, DocumentBrowserDirectoryEntry>();
  const files: DocumentBrowserFileEntry[] = [];

  documents.forEach(document => {
    if (prefix && !document.name.startsWith(prefix)) {
      return;
    }

    const remainder = prefix
      ? document.name.slice(prefix.length)
      : document.name;

    if (!remainder) {
      return;
    }

    const slashIndex = remainder.indexOf('/');
    if (slashIndex >= 0) {
      const directoryName = remainder.slice(0, slashIndex);
      const path = prefix ? `${normalizedDirectory}/${directoryName}` : directoryName;
      directories.set(directoryName, {
        kind: 'directory',
        name: directoryName,
        path,
      });
      return;
    }

    files.push({
      kind: 'file',
      name: remainder,
      path: document.name,
      document,
    });
  });

  const compareNames = (left: { name: string }, right: { name: string }) =>
    left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: 'base',
    });

  return [
    ...Array.from(directories.values()).sort(compareNames),
    ...files.sort(compareNames),
  ];
}

function ActionButton({
  disabled = false,
  label,
  onPress,
  tone = 'ghost',
}: ActionButtonProps) {
  const isPrimary = tone === 'primary';

  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        isPrimary ? styles.buttonPrimary : styles.buttonGhost,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      {isPrimary ? (
        <>
          <View pointerEvents="none" style={styles.buttonPrimaryFill} />
          <View pointerEvents="none" style={styles.buttonPrimaryBloom} />
        </>
      ) : null}
      <Text
        style={[
          styles.buttonText,
          isPrimary ? styles.buttonTextPrimary : styles.buttonTextGhost,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function MetricCard({ label, value }: MetricCardProps) {
  return (
    <View style={[styles.card, styles.cardGlass, styles.metricCard]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

/*
type HeroChipProps = {
  label: string;
};

function HeroChip({ label }: HeroChipProps) {
  return (
    <View style={styles.heroChip}>
      <Text style={styles.heroChipText}>{label}</Text>
    </View>
  );
}
*/

export function ValidationWorkbench() {
  const [documentKind, setDocumentKind] = useState<DocumentKind>('sbg');
  const [fileName, setFileName] = useState(DOCUMENT_PRESETS.sbg.sampleName);
  const [text, setText] = useState(DOCUMENT_PRESETS.sbg.sample);
  const [bridgeInfo, setBridgeInfo] = useState<BridgeInfo | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [validationState, setValidationState] = useState(
    'Bridge ready check pending.',
  );
  const [diagnostics, setDiagnostics] = useState<SbaGenXDiagnostic[]>([]);
  const [curveInfo, setCurveInfo] = useState<CurveInfo | null>(null);
  const [contextState, setContextState] = useState<ContextState | null>(null);
  const [previewState, setPreviewState] = useState<RenderPreviewResult | null>(
    null,
  );
  const [playbackState, setPlaybackState] = useState<PlaybackState | null>(
    null,
  );
  const [documents, setDocuments] = useState<SavedDocumentSummary[]>([]);
  const [documentStoreInfo, setDocumentStoreInfo] =
    useState<DocumentStoreInfo | null>(null);
  const [documentSourceName, setDocumentSourceName] = useState<string | null>(
    null,
  );
  const [isRendering, setIsRendering] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPlayingAction, setIsPlayingAction] = useState(false);
  const [mixDisplayName, setMixDisplayName] = useState<string | null>(null);
  const [isLoadBrowserVisible, setIsLoadBrowserVisible] = useState(false);
  const [loadBrowserPath, setLoadBrowserPath] = useState('');
  const [showDeveloperTools, setShowDeveloperTools] = useState(false);
  const validationRequestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    getBridgeInfo()
      .then(info => {
        if (cancelled) {
          return;
        }

        setBridgeInfo(info);
        setBridgeError(null);
        setValidationState('Native validation bridge ready.');
      })
      .catch(error => {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof Error ? error.message : 'Unknown bridge error.';
        setBridgeError(message);
        setValidationState('Native bridge unavailable.');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refreshNonValidationState() {
      try {
        const [docs, playback, context, storeInfo] = await Promise.all([
          listDocuments(),
          getPlaybackState(),
          getContextState(),
          getDocumentStoreInfo(),
        ]);

        if (cancelled) {
          return;
        }

        setDocuments(docs);
        setPlaybackState(playback);
        setContextState(context);
        setDocumentStoreInfo(storeInfo);
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error
              ? error.message
              : 'Failed to refresh native state.';
          setBridgeError(message);
        }
      }
    }

    refreshNonValidationState().catch(() => {});
    const timer = setInterval(() => {
      refreshNonValidationState().catch(() => {});
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const nativeAvailability = useMemo(() => isNativeBridgeAvailable(), []);
  const resolvedName = ensureDocumentName(fileName, documentKind);
  const mixPathInText = useMemo(() => {
    if (documentKind !== 'sbg') {
      return null;
    }

    return findSafePreambleMixPath(text);
  }, [documentKind, text]);
  const loadBrowserEntries = useMemo(
    () => listDocumentBrowserEntries(documents, loadBrowserPath),
    [documents, loadBrowserPath],
  );
  const loadBrowserParentPath = useMemo(
    () => parentDocumentDirectory(loadBrowserPath),
    [loadBrowserPath],
  );
  const loadBrowserSegments = useMemo(
    () => loadBrowserPath.split('/').filter(Boolean),
    [loadBrowserPath],
  );
  const documentStoreLabel = documentStoreInfo?.label ?? 'App sandbox';
  const isUsingLibraryFolder = documentStoreInfo?.mode === 'library';

  async function refreshDocuments() {
    setDocuments(await listDocuments());
  }

  const effectiveSourceName = documentSourceName ?? resolvedName;

  async function handleRefreshFiles() {
    try {
      const [docs, storeInfo] = await Promise.all([
        listDocuments(),
        getDocumentStoreInfo(),
      ]);
      setDocuments(docs);
      setDocumentStoreInfo(storeInfo);
      setValidationState('Refreshed file list.');
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to refresh file list.',
      );
    }
  }

  async function runValidationFor(
    kind: DocumentKind,
    nextText: string,
    nextResolvedName: string,
  ) {
    const requestId = validationRequestIdRef.current + 1;
    validationRequestIdRef.current = requestId;

    try {
      const result = await validateDocument(kind, nextText, nextResolvedName);

      if (requestId !== validationRequestIdRef.current) {
        return;
      }

      setDiagnostics(result.diagnostics);
      setCurveInfo(result.curveInfo ?? null);
      setBridgeError(null);

      if (result.status !== 0) {
        setValidationState(
          `Native status ${result.status} (${result.statusText}).`,
        );
      } else if (result.diagnosticCount === 0) {
        setValidationState('Live validation passed with no diagnostics.');
      } else {
        setValidationState(
          `Live validation returned ${result.diagnosticCount} diagnostic${
            result.diagnosticCount === 1 ? '' : 's'
          }.`,
        );
      }
    } catch (error) {
      if (requestId !== validationRequestIdRef.current) {
        return;
      }

      const message =
        error instanceof Error ? error.message : 'Unknown validation error.';
      setCurveInfo(null);
      setBridgeError(message);
      setValidationState(
        'Live validation failed before diagnostics were returned.',
      );
    } finally {
      if (requestId !== validationRequestIdRef.current) {
        return;
      }
    }
  }

  /*
  async function handlePrepareContext() {
    if (documentKind !== 'sbg') {
      setValidationState(
        'Render context preparation is only available for .sbg.',
      );
      return;
    }

    setIsPreparing(true);

    try {
      const nextContext = await prepareSbgContext(text, effectiveSourceName);
      setContextState(nextContext);
      setPreviewState(null);
      setBridgeError(nextContext.error || null);
      setValidationState(
        nextContext.status === 0
          ? 'Prepared persistent render context.'
          : `Context prepare failed: ${
              nextContext.error || nextContext.statusText
            }`,
      );
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to prepare context.',
      );
    } finally {
      setIsPreparing(false);
    }
  }
  */

  async function handleRenderPreview() {
    if (documentKind !== 'sbg') {
      setValidationState('Render preview is only available for .sbg.');
      return;
    }

    setIsRendering(true);

    try {
      const nextContext = await prepareSbgContext(text, resolvedName);
      setContextState(nextContext);

      if (nextContext.status !== 0 || !nextContext.prepared) {
        setPreviewState(null);
        setValidationState(
          `Context prepare failed: ${
            nextContext.error || nextContext.statusText
          }`,
        );
        return;
      }

      const preview = await renderPreview(512, 48);
      setPreviewState(preview);
      setBridgeError(preview.error || null);
      setValidationState(
        preview.status === 0
          ? 'Rendered a native PCM smoke-test buffer.'
          : `Preview render failed: ${preview.error || preview.statusText}`,
      );
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to render preview.',
      );
    } finally {
      setIsRendering(false);
    }
  }

  /*
  async function handleResetContext() {
    try {
      const nextContext = await resetContext();
      setContextState(nextContext);
      setValidationState('Reset persistent render context to time 0.');
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to reset context.',
      );
    }
  }
  */

  async function handleStartPlayback() {
    if (documentKind !== 'sbg') {
      setValidationState('Playback is only available for .sbg.');
      return;
    }

    setIsPlayingAction(true);

    try {
      const nextState = await startPlayback(text, effectiveSourceName);
      setPlaybackState(nextState);
      setBridgeError(nextState.lastError || null);
      setValidationState(
        nextState.active
          ? 'Native playback started.'
          : `Playback did not start: ${
              nextState.lastError || nextState.statusText
            }`,
      );
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to start playback.',
      );
    } finally {
      setIsPlayingAction(false);
    }
  }

  async function handleStopPlayback() {
    setIsPlayingAction(true);

    try {
      const nextState = await stopPlayback();
      setPlaybackState(nextState);
      setValidationState('Playback stopped.');
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to stop playback.',
      );
    } finally {
      setIsPlayingAction(false);
    }
  }

  async function handleSaveDocument() {
    setIsSaving(true);

    try {
      const saved = await saveDocument(resolvedName, text);
      setFileName(saved.name);
      setDocumentSourceName(saved.sourceName ?? saved.name);
      await refreshDocuments();
      setValidationState(
        `Saved ${saved.name} to ${
          documentStoreInfo?.mode === 'library'
            ? documentStoreInfo.label
            : 'app sandbox'
        }.`,
      );
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to save document.',
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function handleLoadDocument(name: string) {
    try {
      const loaded = await loadDocument(name);
      const nextKind = inferDocumentKind(loaded.name);
      setDocumentKind(nextKind);
      setFileName(loaded.name);
      setDocumentSourceName(loaded.sourceName ?? loaded.name);
      setText(loaded.text);
      setMixDisplayName(null);
      setDiagnostics([]);
      setCurveInfo(null);
      setPreviewState(null);
      setValidationState(`Loaded ${loaded.name}.`);
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to load document.',
      );
    }
  }

  async function handleOpenLoadBrowser() {
    try {
      const [docs, storeInfo] = await Promise.all([
        listDocuments(),
        getDocumentStoreInfo(),
      ]);
      setDocuments(docs);
      setDocumentStoreInfo(storeInfo);
      setLoadBrowserPath('');
      setIsLoadBrowserVisible(true);
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to open file browser.',
      );
    }
  }

  async function handleLoadFromBrowser(name: string) {
    setIsLoadBrowserVisible(false);
    setLoadBrowserPath('');
    await handleLoadDocument(name);
  }

  async function handlePickLibraryFolder() {
    try {
      const storeInfo = await pickLibraryFolder();
      setDocumentStoreInfo(storeInfo);
      await refreshDocuments();
      setValidationState(
        storeInfo.mode === 'library'
          ? `Using ${storeInfo.label} for saved documents.`
          : 'Continuing to use the app sandbox for documents.',
      );
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to choose library folder.',
      );
    }
  }

  async function loadPreset(nextKind: DocumentKind, preset: 'sample' | 'broken') {
    const targetName =
      preset === 'sample'
        ? DOCUMENT_PRESETS[nextKind].sampleName
        : DOCUMENT_PRESETS[nextKind].brokenName;

    if (preset === 'sample' && documents.some(document => document.name === targetName)) {
      await handleLoadDocument(targetName);
      return;
    }

    setDocumentKind(nextKind);
    setFileName(targetName);
    setDocumentSourceName(null);
    setText(DOCUMENT_PRESETS[nextKind][preset]);
    setMixDisplayName(null);
    setDiagnostics([]);
    setCurveInfo(null);
    setPreviewState(null);
    setValidationState(
      preset === 'sample'
        ? 'Loaded a valid sample document.'
        : 'Loaded a broken sample document.',
    );
  }

  const samplePreview =
    previewState?.samples
      .slice(0, 24)
      .map(value => value.toFixed(3))
      .join(', ') ?? '';

  function handleEditorTextChange(nextText: string) {
    setText(nextText);
    setMixDisplayName(null);
    setDiagnostics([]);
    setCurveInfo(null);
    setPreviewState(null);
    setBridgeError(null);
    setValidationState('Live validation pending...');
  }

  async function handleAddMix() {
    if (documentKind !== 'sbg') {
      setValidationState('Mix files can only be attached to .sbg documents.');
      return;
    }

    try {
      const picked = await pickMixInput();
      if (!picked) {
        setValidationState('Mix selection cancelled.');
        return;
      }

      const nextText = upsertSafePreambleMixPath(text, picked.uri);
      const replacedExistingMix = Boolean(mixPathInText);

      setText(nextText);
      setMixDisplayName(picked.displayName || null);
      setDiagnostics([]);
      setCurveInfo(null);
      setPreviewState(null);
      setBridgeError(null);
      setValidationState(
        `${
          replacedExistingMix ? 'Updated' : 'Added'
        } mix reference for ${picked.displayName || picked.uri}.`,
      );
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to pick mix file.',
      );
    }
  }

  const curveFlags = useMemo(() => {
    if (!curveInfo) {
      return [];
    }

    return [
      curveInfo.hasSolve && 'solve',
      curveInfo.hasCarrierExpr && 'carrier',
      curveInfo.hasAmpExpr && 'amp',
      curveInfo.hasMixampExpr && 'mixamp',
    ].filter(Boolean) as string[];
  }, [curveInfo]);

  useEffect(() => {
    if (!nativeAvailability) {
      return;
    }

    const timeoutId = setTimeout(() => {
      runValidationFor(documentKind, text, effectiveSourceName).catch(() => {});
    }, 180);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [documentKind, effectiveSourceName, nativeAvailability, text]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.root}>
        <WebsiteBackdrop />

        <ScrollView
          nestedScrollEnabled
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.card, styles.cardSoft, styles.heroCard]}>
            <Image source={heroBlueOrb} style={styles.heroAccentBlue} />
            <Image source={heroPinkOrb} style={styles.heroAccentPink} />

            <View style={styles.heroTopRow}>
              <View style={styles.brandLockup}>
                <View style={styles.brandBadge}>
                  <Image source={brandIcon} style={styles.brandIcon} />
                </View>
                <View style={styles.brandCopy}>
                  <Text style={styles.kicker}>Android Native Editor</Text>
                  <Text style={styles.heroTitle}>SBaGenX</Text>
                  <Text style={styles.heroTitleSub}>
                    Retro-lab energy, modern clarity.
                  </Text>
                </View>
              </View>

              {/*
              <View
                style={[
                  styles.statusPill,
                  playbackState?.active
                    ? styles.statusPillActive
                    : styles.statusPillIdle,
                ]}
              >
                <Text
                  style={[
                    styles.statusPillText,
                    playbackState?.active
                      ? styles.statusPillTextActive
                      : styles.statusPillTextIdle,
                  ]}
                >
                  {playbackState?.active ? 'Playback live' : 'Playback idle'}
                </Text>
              </View>
              */}
            </View>

            {/*
            <Text style={styles.heroLede}>
              Validation, persistent render context, preview PCM rendering,
              Android playback, and app-local drafts in one editor-centric
              screen.
            </Text>

            <View style={styles.heroChips}>
              <HeroChip label="Native validation" />
              <HeroChip label="Persistent context" />
              <HeroChip label="PCM smoke test" />
              <HeroChip label="AudioTrack playback" />
            </View>

            <View style={styles.lineage}>
              <Text style={styles.lineageLabel}>Bridge:</Text>
              <Text style={styles.lineageText}>
                {nativeAvailability
                  ? ' Native module detected and ready for editor feedback.'
                  : ' Native module unavailable on this runtime.'}
              </Text>
            </View>
            */}
          </View>

          {showDeveloperTools ? (
            <View style={styles.metricsGrid}>
              <MetricCard
                label="Bridge"
                value={
                  bridgeInfo
                    ? `v${bridgeInfo.bridgeVersion}`
                    : nativeAvailability
                    ? 'Loading...'
                    : 'Unavailable'
                }
              />
              <MetricCard
                label="sbagenxlib"
                value={bridgeInfo ? bridgeInfo.libraryVersion : 'Pending'}
              />
              <MetricCard
                label="Context"
                value={contextState?.prepared ? 'Prepared' : 'Cold'}
              />
              <MetricCard
                label="Playback"
                value={playbackState?.active ? 'Running' : 'Stopped'}
              />
            </View>
          ) : null}

          {!isUsingLibraryFolder ? (
            <View style={[styles.card, styles.cardSoft, styles.panel]}>
              <Text style={styles.panelKicker}>Storage</Text>
              <Text style={styles.panelTitle}>Choose a document library</Text>
              <Text style={styles.panelSub}>
                Pick a folder once and the app will use it for saved documents.
                Bundled examples are copied there automatically so they are
                available outside the app sandbox.
              </Text>

              <View style={styles.buttonRow}>
                <ActionButton
                  label="Choose Library Folder"
                  onPress={() => {
                    handlePickLibraryFolder().catch(() => {});
                  }}
                />
              </View>

              <Text style={styles.note}>
                Until you choose one, documents stay in the app sandbox.
              </Text>

              <Text style={styles.note}>
                Bundled river mixes are copied into the library root beside{' '}
                <Text style={styles.inlineCode}>examples/</Text>.
              </Text>

              <Text style={styles.note}>
                Mixes are still picked system-wide and stay in their original
                location.
              </Text>
            </View>
          ) : null}

          <View style={[styles.card, styles.cardGlass, styles.panel]}>
            <Text style={styles.panelKicker}>Document</Text>
            <Text style={styles.panelTitle}>Editor and files</Text>
            <Text style={styles.panelSub}>
              Switch between timing and curve examples, save into{' '}
              {isUsingLibraryFolder ? documentStoreLabel : 'the app sandbox'},
              attach mix inputs, and validate against the native library.
            </Text>

            <View style={styles.segmentRow}>
              <Pressable
                onPress={() => {
                  loadPreset('sbg', 'sample').catch(() => {});
                }}
                style={[
                  styles.segmentButton,
                  documentKind === 'sbg' && styles.segmentButtonActive,
                ]}
              >
                <Text
                  style={[
                    styles.segmentButtonText,
                    documentKind === 'sbg' && styles.segmentButtonTextActive,
                  ]}
                >
                  .sbg timing
                </Text>
              </Pressable>

              <Pressable
                onPress={() => {
                  loadPreset('sbgf', 'sample').catch(() => {});
                }}
                style={[
                  styles.segmentButton,
                  documentKind === 'sbgf' && styles.segmentButtonActive,
                ]}
              >
                <Text
                  style={[
                    styles.segmentButtonText,
                    documentKind === 'sbgf' && styles.segmentButtonTextActive,
                  ]}
                >
                  .sbgf curve
                </Text>
              </Pressable>
            </View>

            <Text style={styles.fieldLabel}>File Name</Text>
            <TextInput
              onChangeText={setFileName}
              style={styles.input}
              value={fileName}
            />

            <View style={styles.buttonRow}>
              <ActionButton
                label="Load"
                onPress={() => {
                  handleOpenLoadBrowser().catch(() => {});
                }}
              />
              <ActionButton
                disabled={isSaving}
                label={isSaving ? 'Saving...' : 'Save'}
                onPress={handleSaveDocument}
              />
            </View>

            <View style={styles.buttonRow}>
              <ActionButton
                label="Refresh Files"
                onPress={() => {
                  handleRefreshFiles().catch(() => {});
                }}
              />
              {documentKind === 'sbg' ? (
                <ActionButton
                  label={mixPathInText ? 'Change Mix' : 'Add Mix'}
                  onPress={() => {
                    handleAddMix().catch(() => {});
                  }}
                />
              ) : null}
            </View>

            <Text style={styles.note}>
              Save target:{' '}
              <Text style={styles.inlineCode}>{documentStoreLabel}</Text>
            </Text>

            <Text style={styles.note}>
              Document path resolves to:{' '}
              <Text style={styles.inlineCode}>{resolvedName}</Text>
            </Text>

            <Text style={styles.note}>
              Inline diagnostics refresh automatically while you type.
            </Text>

            {documentKind === 'sbg' && mixPathInText ? (
              <Text style={styles.note}>
                Mix file:{' '}
                <Text style={styles.inlineCode}>
                  {mixDisplayName ?? summarizeMixReference(mixPathInText)}
                </Text>
              </Text>
            ) : null}

            <SbaGenXEditor
              diagnostics={diagnostics}
              onTextChange={event => {
                handleEditorTextChange(event.nativeEvent.text);
              }}
              placeholder="Compose .sbg or .sbgf text here."
              style={styles.editor}
              text={text}
            />
          </View>

          <View style={[styles.card, styles.cardSoft, styles.panel]}>
            <Text style={styles.panelKicker}>Runtime</Text>
            <Text style={styles.panelTitle}>Render and playback</Text>
            <Text style={styles.panelSub}>
              Playback prepares a fresh native runtime automatically for{' '}
              <Text style={styles.inlineCode}>.sbg</Text> timing documents.
              Preview tooling is still available behind the developer toggle.
            </Text>

            <View style={styles.buttonRow}>
              {/*
              <ActionButton
                disabled={isPreparing}
                label={isPreparing ? 'Preparing...' : 'Prepare Context'}
                onPress={() => {
                  handlePrepareContext().catch(() => {});
                }}
              />
              */}
              <ActionButton
                label={showDeveloperTools ? 'Hide Developer Tools' : 'Developer Tools'}
                onPress={() => {
                  setShowDeveloperTools(current => !current);
                }}
              />
              <ActionButton
                disabled={isPlayingAction}
                label="Play"
                onPress={() => {
                  handleStartPlayback().catch(() => {});
                }}
                tone="primary"
              />
              <ActionButton
                label="Stop"
                onPress={() => {
                  handleStopPlayback().catch(() => {});
                }}
              />
              {/*
              <ActionButton
                label="Reset Context"
                onPress={() => {
                  handleResetContext().catch(() => {});
                }}
              />
              */}
            </View>

            <Text style={styles.note}>
              Use <Text style={styles.inlineCode}>Play</Text> for the normal
              path. It prepares the runtime and starts audio in one step.
            </Text>

            <View style={styles.metricsGrid}>
              <MetricCard
                label="Prepared"
                value={contextState?.prepared ? 'Yes' : 'No'}
              />
              <MetricCard
                label="Runtime Time"
                value={contextState ? formatSeconds(contextState.timeSec) : '--'}
              />
              <MetricCard
                label="Duration"
                value={
                  contextState ? formatSeconds(contextState.durationSec) : '--'
                }
              />
              <MetricCard
                label="Channels"
                value={contextState ? String(contextState.channels) : '--'}
              />
            </View>

            <Text style={[styles.statusLine, styles.runtimeStatusLine]}>
              {playbackState?.active
                ? `Playback active at ${formatSeconds(
                    playbackState.timeSec,
                  )} of ${formatSeconds(playbackState.durationSec)}.`
                : 'Playback is idle.'}
            </Text>

            {playbackState?.lastError ? (
              <Text style={styles.inlineError}>{playbackState.lastError}</Text>
            ) : null}

            {showDeveloperTools ? (
              <View style={[styles.card, styles.innerGlassCard, styles.developerCard]}>
                <Text style={styles.innerCardTitle}>Developer Tools</Text>
                <Text style={styles.innerCardMeta}>
                  Preview renders a short non-destructive PCM buffer and then
                  restores the context time.
                </Text>

                <View style={styles.buttonRow}>
                  <ActionButton
                    disabled={isRendering}
                    label={isRendering ? 'Rendering...' : 'Render Preview'}
                    onPress={() => {
                      handleRenderPreview().catch(() => {});
                    }}
                  />
                </View>

                {/*
                <View style={styles.buttonRow}>
                  <ActionButton
                    disabled={isPreparing}
                    label={isPreparing ? 'Preparing...' : 'Prepare Context'}
                    onPress={() => {
                      handlePrepareContext().catch(() => {});
                    }}
                  />
                  <ActionButton
                    label="Reset Context"
                    onPress={() => {
                      handleResetContext().catch(() => {});
                    }}
                  />
                </View>
                */}

                {previewState ? (
                  <View style={[styles.card, styles.innerGlassCard]}>
                    <Text style={styles.innerCardTitle}>Preview Buffer</Text>
                    <Text style={styles.innerCardMeta}>
                      {previewState.frameCount} frames, peak{' '}
                      {previewState.peakAbs.toFixed(3)}, rms{' '}
                      {previewState.rms.toFixed(3)}
                    </Text>
                    <Text style={styles.codeBlock}>{samplePreview}</Text>
                  </View>
                ) : (
                  <Text style={styles.emptyState}>
                    Run preview to smoke-test PCM generation without starting
                    playback.
                  </Text>
                )}
              </View>
            ) : null}
          </View>

          <View style={[styles.card, styles.cardGlass, styles.panel]}>
            <Text style={styles.panelKicker}>Diagnostics</Text>
            <Text style={styles.panelTitle}>Validation and bridge state</Text>
            <Text style={styles.panelSub}>
              Native diagnostics come back with spans and codes, matching the
              website’s editor-first direction.
            </Text>

            <Text style={styles.statusLine}>{validationState}</Text>

            {bridgeError ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorTitle}>Bridge Error</Text>
                <Text style={styles.errorBody}>{bridgeError}</Text>
              </View>
            ) : null}

            {documentKind === 'sbgf' ? (
              curveInfo ? (
                <View
                  style={[
                    styles.card,
                    styles.innerGlassCard,
                    styles.curveInfoCard,
                  ]}
                >
                  <Text style={styles.innerCardTitle}>Curve Info</Text>
                  <Text style={styles.innerCardMeta}>
                    Prepared directly by{' '}
                    <Text style={styles.inlineCode}>sbagenxlib</Text>. Solve
                    values appear in the parameter list once the curve validates
                    cleanly.
                  </Text>

                  <View style={styles.curveInfoStats}>
                    <View style={styles.curveInfoStat}>
                      <Text style={styles.curveInfoStatLabel}>Parameters</Text>
                      <Text style={styles.curveInfoStatValue}>
                        {curveInfo.parameterCount}
                      </Text>
                    </View>
                    <View style={styles.curveInfoStat}>
                      <Text style={styles.curveInfoStatLabel}>Beat pieces</Text>
                      <Text style={styles.curveInfoStatValue}>
                        {curveInfo.beatPieceCount}
                      </Text>
                    </View>
                    <View style={styles.curveInfoStat}>
                      <Text style={styles.curveInfoStatLabel}>
                        Carrier pieces
                      </Text>
                      <Text style={styles.curveInfoStatValue}>
                        {curveInfo.carrierPieceCount}
                      </Text>
                    </View>
                    <View style={styles.curveInfoStat}>
                      <Text style={styles.curveInfoStatLabel}>Flags</Text>
                      <Text style={styles.curveInfoStatValue}>
                        {curveFlags.length ? curveFlags.join(', ') : 'none'}
                      </Text>
                    </View>
                  </View>

                  {curveInfo.parameters.length > 0 ? (
                    <View style={styles.curveParamList}>
                      {curveInfo.parameters.map(parameter => (
                        <View
                          key={parameter.name}
                          style={styles.curveParamRow}
                        >
                          <Text style={styles.curveParamName}>
                            {parameter.name}
                          </Text>
                          <Text style={styles.curveParamValue}>
                            {formatCurveValue(parameter.value)}
                          </Text>
                        </View>
                      ))}
                    </View>
                  ) : (
                    <Text style={styles.emptyState}>
                      No explicit parameters declared in this curve.
                    </Text>
                  )}
                </View>
              ) : (
                <Text style={styles.emptyState}>
                  Curve metadata appears here once the active{' '}
                  <Text style={styles.inlineCode}>.sbgf</Text> validates
                  cleanly.
                </Text>
              )
            ) : null}

            {diagnostics.length === 0 ? (
              <Text style={styles.emptyState}>
                No diagnostics recorded yet. Keep typing or load a broken
                sample to exercise the native parser and span reporting.
              </Text>
            ) : (
              diagnostics.map(diagnostic => (
                <View
                  key={`${diagnostic.code}-${formatSpan(diagnostic)}`}
                  style={[styles.card, styles.diagnosticCard]}
                >
                  <View style={styles.diagnosticHeader}>
                    <Text
                      style={[
                        styles.diagnosticBadge,
                        diagnostic.severity === 'warning'
                          ? styles.warningBadge
                          : styles.errorBadge,
                      ]}
                    >
                      {diagnostic.severity.toUpperCase()}
                    </Text>
                    <Text style={styles.diagnosticCode}>{diagnostic.code}</Text>
                    <Text style={styles.diagnosticSpan}>
                      {formatSpan(diagnostic)}
                    </Text>
                  </View>
                  <Text style={styles.diagnosticMessage}>
                    {diagnostic.message}
                  </Text>
                </View>
              ))
            )}
          </View>

          {isUsingLibraryFolder ? (
            <View style={[styles.card, styles.cardSoft, styles.panel]}>
              <Text style={styles.panelKicker}>Storage</Text>
              <Text style={styles.panelTitle}>Document library</Text>
              <Text style={styles.panelSub}>
                Saved files and bundled examples currently live in your chosen
                library folder. You can change that folder here later if
                needed.
              </Text>

              <View style={styles.buttonRow}>
                <ActionButton
                  label="Change Library Folder"
                  onPress={() => {
                    handlePickLibraryFolder().catch(() => {});
                  }}
                />
              </View>

              <Text style={styles.note}>
                Active document storage:{' '}
                <Text style={styles.inlineCode}>{documentStoreLabel}</Text>
              </Text>

              <Text style={styles.note}>
                Bundled river mixes are available in the library root beside{' '}
                <Text style={styles.inlineCode}>examples/</Text>.
              </Text>

              <Text style={styles.note}>
                Mixes are still picked system-wide and stay in their original
                location.
              </Text>
            </View>
          ) : null}
        </ScrollView>

        <Modal
          animationType="fade"
          onRequestClose={() => {
            setIsLoadBrowserVisible(false);
          }}
          transparent
          visible={isLoadBrowserVisible}
        >
          <View style={styles.modalScrim}>
            <Pressable
              onPress={() => {
                setIsLoadBrowserVisible(false);
              }}
              style={StyleSheet.absoluteFill}
            />

            <View style={[styles.card, styles.cardSoft, styles.modalCard]}>
              <Text style={styles.panelKicker}>Load</Text>
              <Text style={styles.panelTitle}>
                {isUsingLibraryFolder
                  ? 'Library Browser'
                  : 'App Storage Browser'}
              </Text>
              <Text style={styles.panelSub}>
                {isUsingLibraryFolder
                  ? `Browse bundled examples and saved files inside ${documentStoreLabel}.`
                  : 'Browse bundled examples and saved files inside the app sandbox.'}
              </Text>

              <ScrollView
                contentContainerStyle={styles.breadcrumbRow}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.breadcrumbScroll}
              >
                <Pressable
                  onPress={() => {
                    setLoadBrowserPath('');
                  }}
                  style={({ pressed }) => [
                    styles.breadcrumbChip,
                    !loadBrowserPath && styles.breadcrumbChipActive,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.breadcrumbText,
                      !loadBrowserPath && styles.breadcrumbTextActive,
                    ]}
                  >
                    {isUsingLibraryFolder ? documentStoreLabel : 'Sandbox'}
                  </Text>
                </Pressable>

                {loadBrowserSegments.map((segment, index) => {
                  const path = loadBrowserSegments.slice(0, index + 1).join('/');
                  const isActive = path === loadBrowserPath;

                  return (
                    <Pressable
                      key={path}
                      onPress={() => {
                        setLoadBrowserPath(path);
                      }}
                      style={({ pressed }) => [
                        styles.breadcrumbChip,
                        isActive && styles.breadcrumbChipActive,
                        pressed && styles.buttonPressed,
                      ]}
                    >
                      <Text
                        style={[
                          styles.breadcrumbText,
                          isActive && styles.breadcrumbTextActive,
                        ]}
                      >
                        {segment}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {loadBrowserParentPath !== null ? (
                <Pressable
                  onPress={() => {
                    setLoadBrowserPath(loadBrowserParentPath);
                  }}
                  style={({ pressed }) => [
                    styles.card,
                    styles.browserEntryCard,
                    styles.browserUpCard,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.browserEntryTitle}>..</Text>
                  <Text style={styles.browserEntryMeta}>Up one folder</Text>
                </Pressable>
              ) : null}

              <ScrollView
                nestedScrollEnabled
                style={styles.modalEntryList}
                showsVerticalScrollIndicator={false}
              >
                {loadBrowserEntries.length === 0 ? (
                  <Text style={styles.emptyState}>
                    This folder is empty.
                  </Text>
                ) : (
                  loadBrowserEntries.map(entry => (
                    <Pressable
                      key={`${entry.kind}:${entry.path}`}
                      onPress={() => {
                        if (entry.kind === 'directory') {
                          setLoadBrowserPath(entry.path);
                          return;
                        }

                        handleLoadFromBrowser(entry.path).catch(() => {});
                      }}
                      style={({ pressed }) => [
                        styles.card,
                        styles.browserEntryCard,
                        pressed && styles.buttonPressed,
                      ]}
                    >
                      <View style={styles.browserEntryHeader}>
                        <Text style={styles.browserEntryTitle}>
                          {entry.name}
                        </Text>
                        <Text style={styles.browserEntryBadge}>
                          {entry.kind === 'directory' ? 'Folder' : 'File'}
                        </Text>
                      </View>
                      <Text style={styles.browserEntryMeta}>
                        {entry.kind === 'directory'
                          ? `Open ${entry.path}`
                          : `${formatBytes(
                              entry.document.sizeBytes,
                            )} • ${formatTimestamp(
                              entry.document.modifiedAtMs,
                            )}`}
                      </Text>
                    </Pressable>
                  ))
                )}
              </ScrollView>

              <View style={styles.buttonRow}>
                <ActionButton
                  label="Close"
                  onPress={() => {
                    setIsLoadBrowserVisible(false);
                  }}
                />
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f6f6f2',
  },
  root: {
    flex: 1,
    backgroundColor: '#f6f6f2',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 32,
    gap: 14,
  },
  card: {
    borderRadius: 24,
    borderWidth: 1,
    borderColor: SURFACE_BORDER,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.08,
    shadowRadius: 24,
    elevation: 4,
  },
  cardSoft: {
    backgroundColor: SURFACE_SOFT,
  },
  cardGlass: {
    backgroundColor: SURFACE_GLASS,
    borderColor: SURFACE_BORDER_LIGHT,
  },
  heroCard: {
    overflow: 'hidden',
    paddingHorizontal: 20,
    paddingVertical: 22,
  },
  heroAccentBlue: {
    position: 'absolute',
    top: -32,
    left: -40,
    width: 180,
    height: 180,
    resizeMode: 'stretch',
  },
  heroAccentPink: {
    position: 'absolute',
    right: -36,
    top: -44,
    width: 170,
    height: 170,
    resizeMode: 'stretch',
  },
  heroTopRow: {
    gap: 14,
    marginBottom: 14,
  },
  brandLockup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  brandBadge: {
    width: 60,
    height: 60,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.88)',
    borderWidth: 1,
    borderColor: 'rgba(20, 20, 20, 0.08)',
  },
  brandIcon: {
    width: 40,
    height: 40,
    resizeMode: 'contain',
  },
  brandCopy: {
    flex: 1,
  },
  kicker: {
    color: 'rgba(20, 20, 20, 0.72)',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  heroTitle: {
    color: '#141414',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -1.4,
    lineHeight: 36,
  },
  heroTitleSub: {
    color: 'rgba(20, 20, 20, 0.62)',
    fontSize: 17,
    fontWeight: '700',
    marginTop: 8,
  },
  heroLede: {
    color: 'rgba(20, 20, 20, 0.78)',
    fontSize: 15,
    lineHeight: 23,
    marginBottom: 16,
  },
  heroChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16,
  },
  heroChip: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(255, 255, 255, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.10)',
  },
  heroChipText: {
    color: '#141414',
    fontSize: 13,
    fontWeight: '700',
  },
  lineage: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(20, 20, 20, 0.14)',
    borderStyle: 'dashed',
    paddingTop: 14,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  lineageLabel: {
    color: 'rgba(20, 20, 20, 0.72)',
    fontSize: 14,
    fontWeight: '900',
  },
  lineageText: {
    color: 'rgba(20, 20, 20, 0.72)',
    fontSize: 14,
    lineHeight: 20,
  },
  statusPill: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  statusPillIdle: {
    backgroundColor: 'rgba(255, 255, 255, 0.62)',
    borderColor: 'rgba(20, 20, 20, 0.10)',
  },
  statusPillActive: {
    backgroundColor: 'rgba(58, 124, 255, 0.12)',
    borderColor: 'rgba(58, 124, 255, 0.18)',
  },
  statusPillText: {
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  statusPillTextIdle: {
    color: 'rgba(20, 20, 20, 0.78)',
  },
  statusPillTextActive: {
    color: '#2b67de',
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  metricCard: {
    flexGrow: 1,
    flexBasis: '47%',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  metricLabel: {
    color: 'rgba(20, 20, 20, 0.68)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  metricValue: {
    color: '#141414',
    fontSize: 16,
    fontWeight: '800',
  },
  panel: {
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  panelKicker: {
    color: 'rgba(20, 20, 20, 0.68)',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.0,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  panelTitle: {
    color: '#141414',
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.5,
    marginBottom: 6,
  },
  panelSub: {
    color: 'rgba(20, 20, 20, 0.68)',
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 14,
  },
  fieldLabel: {
    color: 'rgba(20, 20, 20, 0.74)',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.9,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: 'rgba(255, 255, 255, 0.75)',
    borderColor: 'rgba(0, 0, 0, 0.12)',
    borderRadius: 12,
    borderWidth: 1,
    color: '#141414',
    marginBottom: 14,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  segmentRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 14,
  },
  segmentButton: {
    flex: 1,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.10)',
    backgroundColor: 'rgba(255, 255, 255, 0.60)',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  segmentButtonActive: {
    backgroundColor: 'rgba(58, 124, 255, 0.12)',
    borderColor: 'rgba(58, 124, 255, 0.22)',
  },
  segmentButtonText: {
    color: 'rgba(20, 20, 20, 0.78)',
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
  },
  segmentButtonTextActive: {
    color: '#2b67de',
  },
  buttonRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 12,
  },
  modalScrim: {
    flex: 1,
    backgroundColor: 'rgba(10, 12, 18, 0.36)',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 24,
  },
  modalCard: {
    maxHeight: '82%',
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  breadcrumbScroll: {
    marginBottom: 12,
  },
  breadcrumbRow: {
    flexDirection: 'row',
    gap: 8,
  },
  breadcrumbChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.10)',
    backgroundColor: 'rgba(255, 255, 255, 0.60)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  breadcrumbChipActive: {
    backgroundColor: 'rgba(58, 124, 255, 0.12)',
    borderColor: 'rgba(58, 124, 255, 0.22)',
  },
  breadcrumbText: {
    color: 'rgba(20, 20, 20, 0.78)',
    fontSize: 13,
    fontWeight: '800',
  },
  breadcrumbTextActive: {
    color: '#2b67de',
  },
  modalEntryList: {
    marginBottom: 12,
  },
  browserEntryCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.62)',
    borderColor: 'rgba(0, 0, 0, 0.10)',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  browserUpCard: {
    marginBottom: 10,
  },
  browserEntryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 4,
  },
  browserEntryTitle: {
    color: '#141414',
    flex: 1,
    fontSize: 15,
    fontWeight: '800',
  },
  browserEntryBadge: {
    color: 'rgba(20, 20, 20, 0.64)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  browserEntryMeta: {
    color: 'rgba(20, 20, 20, 0.66)',
    fontSize: 13,
    lineHeight: 18,
  },
  button: {
    minWidth: 140,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 999,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  buttonGhost: {
    backgroundColor: 'rgba(255, 255, 255, 0.60)',
    borderColor: 'rgba(0, 0, 0, 0.10)',
  },
  buttonPrimary: {
    backgroundColor: '#3a7cff',
    borderColor: 'rgba(58, 124, 255, 0.24)',
    shadowColor: '#3a7cff',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 22,
    elevation: 4,
  },
  buttonPrimaryFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#3a7cff',
  },
  buttonPrimaryBloom: {
    position: 'absolute',
    right: -18,
    top: -24,
    width: 96,
    height: 96,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 46, 166, 0.70)',
  },
  buttonDisabled: {
    opacity: 0.58,
  },
  buttonPressed: {
    opacity: 0.88,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '800',
    position: 'relative',
  },
  buttonTextGhost: {
    color: '#141414',
  },
  buttonTextPrimary: {
    color: '#ffffff',
  },
  note: {
    color: 'rgba(20, 20, 20, 0.68)',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 10,
  },
  inlineCode: {
    color: 'rgba(20, 20, 20, 0.84)',
    fontFamily: 'monospace',
  },
  editor: {
    height: 360,
    overflow: 'hidden',
  },
  statusLine: {
    color: 'rgba(20, 20, 20, 0.78)',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
  },
  runtimeStatusLine: {
    marginTop: 12,
    marginBottom: 4,
  },
  inlineError: {
    color: '#9f1c23',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  innerGlassCard: {
    backgroundColor: SURFACE_GLASS,
    borderColor: SURFACE_BORDER_LIGHT,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  developerCard: {
    marginTop: 4,
  },
  curveInfoCard: {
    marginBottom: 12,
  },
  innerCardTitle: {
    color: '#141414',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
  },
  innerCardMeta: {
    color: 'rgba(20, 20, 20, 0.68)',
    fontSize: 13,
    marginBottom: 10,
  },
  curveInfoStats: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 12,
  },
  curveInfoStat: {
    backgroundColor: 'rgba(255, 255, 255, 0.58)',
    borderColor: 'rgba(0, 0, 0, 0.08)',
    borderRadius: 14,
    borderWidth: 1,
    minWidth: 108,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  curveInfoStatLabel: {
    color: 'rgba(20, 20, 20, 0.66)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  curveInfoStatValue: {
    color: '#141414',
    fontSize: 14,
    fontWeight: '800',
  },
  curveParamList: {
    borderColor: 'rgba(0, 0, 0, 0.08)',
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  curveParamRow: {
    backgroundColor: 'rgba(255, 255, 255, 0.5)',
    borderBottomColor: 'rgba(0, 0, 0, 0.08)',
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  curveParamName: {
    color: '#141414',
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '800',
  },
  curveParamValue: {
    color: 'rgba(20, 20, 20, 0.82)',
    fontFamily: 'monospace',
    fontSize: 13,
  },
  codeBlock: {
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
    borderColor: 'rgba(0, 0, 0, 0.10)',
    borderRadius: 16,
    borderWidth: 1,
    color: 'rgba(20, 20, 20, 0.84)',
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  errorCard: {
    backgroundColor: 'rgba(255, 232, 236, 0.92)',
    borderColor: 'rgba(159, 28, 35, 0.14)',
    borderRadius: 16,
    borderWidth: 1,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  errorTitle: {
    color: '#9f1c23',
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 6,
  },
  errorBody: {
    color: '#9f1c23',
    fontSize: 14,
    lineHeight: 20,
  },
  emptyState: {
    color: 'rgba(20, 20, 20, 0.68)',
    fontSize: 15,
    lineHeight: 22,
  },
  diagnosticCard: {
    backgroundColor: SURFACE_GLASS,
    borderColor: SURFACE_BORDER_LIGHT,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 10,
  },
  diagnosticHeader: {
    marginBottom: 8,
  },
  diagnosticBadge: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.8,
    marginBottom: 8,
  },
  errorBadge: {
    backgroundColor: 'rgba(255, 46, 166, 0.12)',
    color: '#9f1c23',
  },
  warningBadge: {
    backgroundColor: 'rgba(255, 216, 115, 0.58)',
    color: '#6f5200',
  },
  diagnosticCode: {
    color: '#141414',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 4,
  },
  diagnosticSpan: {
    color: 'rgba(20, 20, 20, 0.68)',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  diagnosticMessage: {
    color: 'rgba(20, 20, 20, 0.78)',
    fontSize: 15,
    lineHeight: 22,
  },
  documentCard: {
    backgroundColor: SURFACE_GLASS,
    borderColor: SURFACE_BORDER_LIGHT,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  documentCardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 4,
  },
  documentName: {
    color: '#141414',
    flex: 1,
    fontSize: 15,
    fontWeight: '800',
  },
  documentSize: {
    color: 'rgba(20, 20, 20, 0.68)',
    fontSize: 12,
    fontWeight: '800',
  },
  documentMeta: {
    color: 'rgba(20, 20, 20, 0.68)',
    fontSize: 12,
  },
});
