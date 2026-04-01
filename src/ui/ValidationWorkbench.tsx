import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ViewStyle,
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
  pickDocumentToLoad,
  pickLibraryFolder,
  pickMixInput,
  prepareProgramContext,
  prepareSbgContext,
  renderPreview,
  saveDocument,
  startProgramPlayback,
  startPlayback,
  stopPlayback,
    type BridgeInfo,
    type ContextState,
    type CurveInfo,
    type DocumentStoreInfo,
    type DocumentKind,
    type PlaybackState,
  type ProgramKind,
  type ProgramRuntimeRequest,
  type RenderPreviewResult,
  type SbaGenXDiagnostic,
  validateDocument,
} from '../native/sbagenx';
import { SbaGenXEditor } from './SbaGenXEditor';
import { WebsiteBackdrop } from './WebsiteBackdrop';

const brandIcon = require('../assets/sbagenx-icon.png');
const heroBlueOrb = require('../assets/hero-blue-orb.png');
const heroPinkOrb = require('../assets/hero-pink-orb.png');

const SURFACE_SOFT = 'rgba(235, 235, 229, 0.74)';
const SURFACE_GLASS = 'rgba(232, 232, 226, 0.65)';
const SURFACE_BORDER = 'rgba(255, 255, 255, 0.10)';
const SURFACE_BORDER_LIGHT = 'rgba(255, 255, 255, 0.18)';

const DEFAULT_SBG_NAME = 'examples/plus/deep-sleep-aid.sbg';
const DEFAULT_SBGF_NAME = 'examples/basics/curve-expfit-solve-demo.sbgf';
const DEFAULT_PROGRAM_TIMES = {
  dropMinutes: '30',
  holdMinutes: '30',
  wakeMinutes: '3',
};
const DEFAULT_PROGRAM_MAIN_ARGS: Record<ProgramKind, string> = {
  drop: '00ls+^/1',
  sigmoid: '00ls+^/1:l=0.125',
  slide: '200+10/1',
  curve: '00ls/1:l=0.15',
};

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

type RuntimeMode = 'sequence' | 'program';

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

type GlassCardProps = {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
};

function formatSpan(diagnostic: SbaGenXDiagnostic): string {
  return `${diagnostic.line}:${diagnostic.column} -> ${diagnostic.endLine}:${diagnostic.endColumn}`;
}

function formatSeconds(value: number): string {
  return `${value.toFixed(2)}s`;
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

function programKindLabel(programKind: ProgramKind): string {
  switch (programKind) {
    case 'drop':
      return 'drop';
    case 'sigmoid':
      return 'sigmoid';
    case 'slide':
      return 'slide';
    case 'curve':
      return 'curve';
  }
}

function parseMinutesField(value: string, fallbackMinutes: number): number {
  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallbackMinutes * 60;
  }

  return Math.round(parsed * 60);
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

function GlassCard({ children, style }: GlassCardProps) {
  return (
    <View style={[styles.card, styles.cardGlass, style]}>
      {children}
    </View>
  );
}

function MetricCard({ label, value }: MetricCardProps) {
  return (
    <GlassCard style={styles.metricCard}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </GlassCard>
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
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>('program');
  const [programKind, setProgramKind] = useState<ProgramKind>('drop');
  const [sequenceFileName, setSequenceFileName] = useState(DEFAULT_SBG_NAME);
  const [sequenceText, setSequenceText] = useState(VALID_SBG_SAMPLE);
  const [sequenceSourceName, setSequenceSourceName] = useState<string | null>(
    null,
  );
  const [curveFileName, setCurveFileName] = useState(DEFAULT_SBGF_NAME);
  const [curveText, setCurveText] = useState(VALID_SBGF_SAMPLE);
  const [curveSourceName, setCurveSourceName] = useState<string | null>(null);
  const [programMainArgs, setProgramMainArgs] = useState<Record<ProgramKind, string>>(
    DEFAULT_PROGRAM_MAIN_ARGS,
  );
  const [programDropMinutes, setProgramDropMinutes] = useState(
    DEFAULT_PROGRAM_TIMES.dropMinutes,
  );
  const [programHoldMinutes, setProgramHoldMinutes] = useState(
    DEFAULT_PROGRAM_TIMES.holdMinutes,
  );
  const [programWakeMinutes, setProgramWakeMinutes] = useState(
    DEFAULT_PROGRAM_TIMES.wakeMinutes,
  );
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
  const [documentStoreInfo, setDocumentStoreInfo] =
    useState<DocumentStoreInfo | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPlayingAction, setIsPlayingAction] = useState(false);
  const [sequenceMixDisplayName, setSequenceMixDisplayName] = useState<string | null>(
    null,
  );
  const [sequenceMixPathOverride, setSequenceMixPathOverride] =
    useState<string | null>(null);
  const [sequenceMixLooperSpec, setSequenceMixLooperSpec] = useState('');
  const [programMixPath, setProgramMixPath] = useState<string | null>(null);
  const [programMixDisplayName, setProgramMixDisplayName] = useState<string | null>(
    null,
  );
  const [programMixLooperSpec, setProgramMixLooperSpec] = useState('');
  const [isProgramPickerVisible, setIsProgramPickerVisible] = useState(false);
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

    async function refreshInitialState() {
      try {
        const [playback, context, storeInfo] = await Promise.all([
          getPlaybackState(),
          getContextState(),
          getDocumentStoreInfo(),
        ]);

        if (cancelled) {
          return;
        }

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

    refreshInitialState().catch(() => {});
    const timer = setInterval(() => {
      Promise.all([getPlaybackState(), getContextState()])
        .then(([playback, context]) => {
          if (cancelled) {
            return;
          }

          setPlaybackState(playback);
          setContextState(context);
        })
        .catch(error => {
          if (!cancelled) {
            const message =
              error instanceof Error
                ? error.message
                : 'Failed to refresh native state.';
            setBridgeError(message);
          }
        });
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const nativeAvailability = useMemo(() => isNativeBridgeAvailable(), []);
  const sequenceResolvedName = ensureDocumentName(sequenceFileName, 'sbg');
  const curveResolvedName = ensureDocumentName(curveFileName, 'sbgf');
  const activeDocumentKind: DocumentKind | null =
    runtimeMode === 'sequence'
      ? 'sbg'
      : programKind === 'curve'
      ? 'sbgf'
      : null;
  const activeResolvedName =
    activeDocumentKind === 'sbg'
      ? sequenceResolvedName
      : activeDocumentKind === 'sbgf'
      ? curveResolvedName
      : null;
  const activeText =
    activeDocumentKind === 'sbg'
      ? sequenceText
      : activeDocumentKind === 'sbgf'
      ? curveText
      : '';
  const activeSourceName =
    runtimeMode === 'sequence'
      ? sequenceSourceName ?? sequenceResolvedName
      : programKind === 'curve'
      ? curveSourceName ?? curveResolvedName
      : `program:${programKind}`;
  const sequenceMixPathInText = useMemo(
    () => findSafePreambleMixPath(sequenceText),
    [sequenceText],
  );
  const effectiveSequenceMixPath =
    sequenceMixPathOverride ?? sequenceMixPathInText;
  const currentProgramMainArg = programMainArgs[programKind];
  const documentStoreLabel = documentStoreInfo?.label ?? 'App sandbox';
  const isUsingLibraryFolder = documentStoreInfo?.mode === 'library';

  async function handleRefreshFiles() {
    try {
      const [docs, storeInfo] = await Promise.all([
        listDocuments(),
        getDocumentStoreInfo(),
      ]);
      setDocumentStoreInfo(storeInfo);
      setValidationState(
        `Refreshed files. Indexed ${docs.length} document${
          docs.length === 1 ? '' : 's'
        } in ${storeInfo.label}.`,
      );
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

  function buildProgramRequest(): ProgramRuntimeRequest {
    return {
      programKind,
      mainArg: currentProgramMainArg,
      dropTimeSec: parseMinutesField(programDropMinutes, 30),
      holdTimeSec: parseMinutesField(programHoldMinutes, 30),
      wakeTimeSec: parseMinutesField(programWakeMinutes, 3),
      curveText: programKind === 'curve' ? curveText : null,
      sourceName:
        programKind === 'curve'
          ? curveSourceName ?? curveResolvedName
          : `program:${programKind}`,
      mixPath: programMixPath,
      mixLooperSpec: programMixLooperSpec.trim() || null,
    };
  }

  function applyLoadedDocument(
    name: string,
    loadedText: string,
    sourceName?: string,
  ) {
    const nextKind = inferDocumentKind(name);
    setDiagnostics([]);
    setCurveInfo(null);
    setPreviewState(null);
    setBridgeError(null);

    if (nextKind === 'sbg') {
      setRuntimeMode('sequence');
      setSequenceFileName(name);
      setSequenceSourceName(sourceName ?? name);
      setSequenceText(loadedText);
      setSequenceMixPathOverride(null);
      setSequenceMixDisplayName(null);
      setSequenceMixLooperSpec('');
    } else {
      setRuntimeMode('program');
      setProgramKind('curve');
      setCurveFileName(name);
      setCurveSourceName(sourceName ?? name);
      setCurveText(loadedText);
    }

    setValidationState(`Loaded ${name}.`);
  }

  async function handleRenderPreview() {
    setIsRendering(true);

    try {
      const nextContext =
        runtimeMode === 'sequence'
          ? await prepareSbgContext(
              sequenceText,
              activeSourceName,
              sequenceMixPathOverride,
              effectiveSequenceMixPath
                ? sequenceMixLooperSpec.trim() || null
                : null,
            )
          : await prepareProgramContext(buildProgramRequest());
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

  async function handleStartPlayback() {
    setIsPlayingAction(true);
    setBridgeError(null);
    setValidationState('Starting native playback...');

    try {
      const nextState =
        runtimeMode === 'sequence'
          ? await startPlayback(
              sequenceText,
              activeSourceName,
              sequenceMixPathOverride,
              effectiveSequenceMixPath
                ? sequenceMixLooperSpec.trim() || null
                : null,
            )
          : await startProgramPlayback(buildProgramRequest());
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
    if (!activeDocumentKind || !activeResolvedName) {
      setValidationState('Only sequence files and curve files can be saved.');
      return;
    }

    setIsSaving(true);
    setBridgeError(null);
    setValidationState('Saving document...');

    try {
      const saved = await saveDocument(activeResolvedName, activeText);
      if (activeDocumentKind === 'sbg') {
        setSequenceFileName(saved.name);
        setSequenceSourceName(saved.sourceName ?? saved.name);
      } else {
        setCurveFileName(saved.name);
        setCurveSourceName(saved.sourceName ?? saved.name);
      }
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

  async function handleOpenLoadBrowser() {
    try {
      setBridgeError(null);
      setValidationState('Opening Android document picker...');
      const picked = await pickDocumentToLoad();
      if (!picked) {
        setValidationState('Document selection cancelled.');
        return;
      }

      applyLoadedDocument(picked.name, picked.text, picked.sourceName);
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to open document picker.',
      );
    }
  }

  async function handlePickLibraryFolder() {
    try {
      const storeInfo = await pickLibraryFolder();
      setDocumentStoreInfo(storeInfo);
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

  const samplePreview =
    previewState?.samples
      .slice(0, 24)
      .map(value => value.toFixed(3))
      .join(', ') ?? '';

  function handleEditorTextChange(nextText: string) {
    if (activeDocumentKind === 'sbg') {
      setSequenceText(nextText);
    } else if (activeDocumentKind === 'sbgf') {
      setCurveText(nextText);
    }
    setDiagnostics([]);
    setCurveInfo(null);
    setPreviewState(null);
    setBridgeError(null);
    setValidationState('Live validation pending...');
  }

  async function handleAddMix() {
    try {
      setBridgeError(null);
      setValidationState('Opening Android file picker...');
      const picked = await pickMixInput();
      if (!picked || !picked.uri.trim()) {
        setValidationState('Mix selection cancelled.');
        return;
      }

      if (runtimeMode === 'sequence') {
        const replacedExistingMix = Boolean(effectiveSequenceMixPath);
        setSequenceMixPathOverride(picked.uri);
        setSequenceMixDisplayName(picked.displayName || null);
        setSequenceMixLooperSpec(picked.embeddedLooperSpec?.trim() ?? '');
        setValidationState(
          `${
            replacedExistingMix ? 'Updated' : 'Added'
          } mix reference for ${picked.displayName || picked.uri}.${
            picked.embeddedLooperSpec?.trim()
              ? ' Embedded SBAGEN_LOOPER metadata prepopulated the field.'
              : ''
          }`,
        );
      } else {
        setProgramMixPath(picked.uri);
        setProgramMixDisplayName(picked.displayName || null);
        setProgramMixLooperSpec(picked.embeddedLooperSpec?.trim() ?? '');
        setValidationState(
          `Selected mix input ${picked.displayName || picked.uri} for the ${programKindLabel(
            programKind,
          )} program.${
            picked.embeddedLooperSpec?.trim()
              ? ' Embedded SBAGEN_LOOPER metadata prepopulated the field.'
              : ''
          }`,
        );
      }

      setDiagnostics([]);
      setCurveInfo(null);
      setPreviewState(null);
      setBridgeError(null);
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

    if (!activeDocumentKind || !activeResolvedName) {
      validationRequestIdRef.current += 1;
      setDiagnostics([]);
      setCurveInfo(null);
      setBridgeError(null);
      setValidationState(
        'Built-in program mode uses direct program arguments. Curve validation appears here only when the curve editor is active.',
      );
      return;
    }

    const timeoutId = setTimeout(() => {
      runValidationFor(
        activeDocumentKind,
        activeText,
        activeSourceName,
      ).catch(() => {});
    }, 180);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [
    activeDocumentKind,
    activeResolvedName,
    activeSourceName,
    activeText,
    nativeAvailability,
  ]);

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
          <GlassCard style={styles.heroCard}>
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
          </GlassCard>

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
            <GlassCard style={styles.panel}>
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
            </GlassCard>
          ) : null}

          <GlassCard style={styles.panel}>
            <Text style={styles.panelKicker}>Mode</Text>
            <Text style={styles.panelTitle}>Choose the runtime path</Text>
            <Text style={styles.panelSub}>
              Sequence mode edits and plays full <Text style={styles.inlineCode}>.sbg</Text>{' '}
              files. Built-in Program mode drives <Text style={styles.inlineCode}>-p</Text>{' '}
              programs, with the <Text style={styles.inlineCode}>curve</Text> program using the{' '}
              <Text style={styles.inlineCode}>.sbgf</Text> editor.
            </Text>

            <View style={styles.radioGroup}>
              <Pressable
                onPress={() => {
                  setRuntimeMode('program');
                }}
                style={({ pressed }) => [
                  styles.radioCard,
                  runtimeMode === 'program' && styles.radioCardActive,
                  pressed && styles.buttonPressed,
                ]}
              >
                <View style={styles.radioIndicator}>
                  <View
                    style={[
                      styles.radioIndicatorDot,
                      runtimeMode === 'program' && styles.radioIndicatorDotActive,
                    ]}
                  />
                </View>
                <View style={styles.radioCopy}>
                  <Text style={styles.radioLabel}>Built-in Program</Text>
                  <Text style={styles.radioSub}>
                    Run <Text style={styles.inlineCode}>drop</Text>,{' '}
                    <Text style={styles.inlineCode}>slide</Text>,{' '}
                    <Text style={styles.inlineCode}>sigmoid</Text>, or{' '}
                    <Text style={styles.inlineCode}>curve</Text>.
                  </Text>
                </View>
              </Pressable>

              <Pressable
                onPress={() => {
                  setRuntimeMode('sequence');
                }}
                style={({ pressed }) => [
                  styles.radioCard,
                  runtimeMode === 'sequence' && styles.radioCardActive,
                  pressed && styles.buttonPressed,
                ]}
              >
                <View style={styles.radioIndicator}>
                  <View
                    style={[
                      styles.radioIndicatorDot,
                      runtimeMode === 'sequence' && styles.radioIndicatorDotActive,
                    ]}
                  />
                </View>
                <View style={styles.radioCopy}>
                  <Text style={styles.radioLabel}>Sequence File</Text>
                  <Text style={styles.radioSub}>
                    Edit and play <Text style={styles.inlineCode}>.sbg</Text>{' '}
                    timing files.
                  </Text>
                </View>
              </Pressable>
            </View>
          </GlassCard>

          {runtimeMode === 'program' ? (
            <GlassCard style={styles.panel}>
              <Text style={styles.panelKicker}>Program</Text>
              <Text style={styles.panelTitle}>Built-in program settings</Text>
              <Text style={styles.panelSub}>
                Choose a program, provide its main argument, and optionally
                attach a mix. Use <Text style={styles.inlineCode}>+</Text> to
                activate hold-time and <Text style={styles.inlineCode}>^</Text>{' '}
                to activate wake-time in the main argument field.
              </Text>

              <Text style={styles.fieldLabel}>Program</Text>
              <Pressable
                onPress={() => {
                  setIsProgramPickerVisible(true);
                }}
                style={({ pressed }) => [
                  styles.selectField,
                  pressed && styles.buttonPressed,
                ]}
              >
                <Text style={styles.selectFieldValue}>
                  {programKindLabel(programKind)}
                </Text>
                <Text style={styles.selectFieldChevron}>▼</Text>
              </Pressable>

              <View style={styles.inlineField}>
                <Text style={styles.fieldLabel}>
                  {programKind === 'slide' ? 'Duration (min)' : 'Drop-Time (min)'}
                </Text>
                <TextInput
                  keyboardType="decimal-pad"
                  onChangeText={setProgramDropMinutes}
                  style={styles.input}
                  value={programDropMinutes}
                />
              </View>

              <View style={styles.inlineField}>
                <Text style={styles.fieldLabel}>Hold-Time (min)</Text>
                <TextInput
                  editable={programKind !== 'slide'}
                  keyboardType="decimal-pad"
                  onChangeText={setProgramHoldMinutes}
                  style={[
                    styles.input,
                    programKind === 'slide' && styles.inputDisabled,
                  ]}
                  value={programHoldMinutes}
                />
              </View>

              <View style={styles.inlineField}>
                <Text style={styles.fieldLabel}>Wake-Time (min)</Text>
                <TextInput
                  editable={programKind !== 'slide'}
                  keyboardType="decimal-pad"
                  onChangeText={setProgramWakeMinutes}
                  style={[
                    styles.input,
                    programKind === 'slide' && styles.inputDisabled,
                  ]}
                  value={programWakeMinutes}
                />
              </View>

              <Text style={styles.fieldLabel}>Main Argument</Text>
              <TextInput
                onChangeText={nextValue => {
                  setProgramMainArgs(current => ({
                    ...current,
                    [programKind]: nextValue,
                  }));
                  setDiagnostics([]);
                  setCurveInfo(null);
                  setPreviewState(null);
                  setBridgeError(null);
                  setValidationState('Program settings updated.');
                }}
                style={styles.input}
                value={currentProgramMainArg}
              />

              <View style={styles.buttonRow}>
                <ActionButton
                  label={programMixPath ? 'Change Mix' : 'Add Mix'}
                  onPress={() => {
                    handleAddMix().catch(() => {});
                  }}
                />
              </View>

              <Text style={styles.note}>
                Program source:{' '}
                <Text style={styles.inlineCode}>
                  {programKind === 'curve'
                    ? curveSourceName ?? curveResolvedName
                    : `program:${programKind}`}
                </Text>
              </Text>

              {programMixPath ? (
                <Text style={styles.note}>
                  Mix file:{' '}
                  <Text style={styles.inlineCode}>
                    {programMixDisplayName ??
                      summarizeMixReference(programMixPath)}
                  </Text>
                </Text>
              ) : (
                <Text style={styles.note}>
                  No mix file selected for this program yet.
                </Text>
              )}

              {programMixPath ? (
                <>
                  <Text style={styles.fieldLabel}>SBAGEN_LOOPER</Text>
                  <TextInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={setProgramMixLooperSpec}
                    placeholder="i s928 f5 c1 w1 d218-1146"
                    style={styles.input}
                    value={programMixLooperSpec}
                  />
                  <Text style={styles.note}>
                    Embedded{' '}
                    <Text style={styles.inlineCode}>SBAGEN_LOOPER</Text>{' '}
                    metadata prepopulates here when present. Edit it to refine
                    the loop, or clear the field to use the file tag directly.
                  </Text>
                </>
              ) : null}
            </GlassCard>
          ) : null}

          {activeDocumentKind ? (
            <GlassCard style={styles.panel}>
              <Text style={styles.panelKicker}>Document</Text>
              <Text style={styles.panelTitle}>
                {activeDocumentKind === 'sbg'
                  ? 'Sequence editor and files'
                  : 'Curve editor and files'}
              </Text>
              <Text style={styles.panelSub}>
                {activeDocumentKind === 'sbg'
                  ? `Open, edit, and save .sbg files in ${
                      isUsingLibraryFolder ? documentStoreLabel : 'the app sandbox'
                    }. Mix loading and SBAGEN_LOOPER live in app state, while any existing -m preamble entry is still respected as a fallback.`
                  : `Open, edit, and save the .sbgf file used by the curve program in ${
                      isUsingLibraryFolder ? documentStoreLabel : 'the app sandbox'
                    }.`}
              </Text>

              <Text style={styles.fieldLabel}>File Name</Text>
              <TextInput
                onChangeText={value => {
                  if (activeDocumentKind === 'sbg') {
                    setSequenceFileName(value);
                  } else {
                    setCurveFileName(value);
                  }
                }}
                style={styles.input}
                value={
                  activeDocumentKind === 'sbg' ? sequenceFileName : curveFileName
                }
              />

              <View style={[styles.buttonRow, styles.documentActionRow]}>
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

              <View style={[styles.buttonRow, styles.documentActionRow]}>
                <ActionButton
                  label="Refresh Files"
                  onPress={() => {
                    handleRefreshFiles().catch(() => {});
                  }}
                />
                {activeDocumentKind === 'sbg' ? (
                  <ActionButton
                    label={effectiveSequenceMixPath ? 'Change Mix' : 'Add Mix'}
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
                <Text style={styles.inlineCode}>{activeResolvedName}</Text>
              </Text>

              <Text style={styles.note}>
                Inline diagnostics refresh automatically while you type.
              </Text>

              {activeDocumentKind === 'sbg' && effectiveSequenceMixPath ? (
                <Text style={styles.note}>
                  Mix file:{' '}
                  <Text style={styles.inlineCode}>
                    {sequenceMixDisplayName ??
                      summarizeMixReference(effectiveSequenceMixPath)}
                  </Text>
                </Text>
              ) : null}

              {activeDocumentKind === 'sbg' && effectiveSequenceMixPath ? (
                <>
                  <Text style={styles.fieldLabel}>SBAGEN_LOOPER</Text>
                  <TextInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    onChangeText={setSequenceMixLooperSpec}
                    placeholder="i s928 f5 c1 w1 d218-1146"
                    style={styles.input}
                    value={sequenceMixLooperSpec}
                  />
                  <Text style={styles.note}>
                    Embedded{' '}
                    <Text style={styles.inlineCode}>SBAGEN_LOOPER</Text>{' '}
                    metadata prepopulates here when present. Edit it to refine
                    the loop, or clear the field to use the file tag directly.
                  </Text>
                </>
              ) : null}

              <SbaGenXEditor
                diagnostics={diagnostics}
                onTextChange={event => {
                  handleEditorTextChange(event.nativeEvent.text);
                }}
                placeholder="Compose .sbg or .sbgf text here."
                style={styles.editor}
                text={activeText}
              />
            </GlassCard>
          ) : null}

          <GlassCard style={styles.panel}>
            <Text style={styles.panelKicker}>Runtime</Text>
            <Text style={styles.panelTitle}>Render and playback</Text>
            <Text style={styles.panelSub}>
              Playback prepares a fresh native runtime automatically for the
              current mode, whether that is a sequence file or a built-in
              program. Preview tooling is still available behind the developer
              toggle.
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
          </GlassCard>

          <GlassCard style={styles.panel}>
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

            {runtimeMode === 'program' && programKind === 'curve' ? (
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
                {activeDocumentKind
                  ? 'No diagnostics recorded yet. Keep typing to exercise the native parser and span reporting.'
                  : 'No inline document diagnostics are active in this mode.'}
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
          </GlassCard>

          {isUsingLibraryFolder ? (
            <GlassCard style={styles.panel}>
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
            </GlassCard>
          ) : null}
        </ScrollView>

        <Modal
          animationType="fade"
          onRequestClose={() => {
            setIsProgramPickerVisible(false);
          }}
          transparent
          visible={isProgramPickerVisible}
        >
          <View style={styles.modalScrim}>
            <Pressable
              onPress={() => {
                setIsProgramPickerVisible(false);
              }}
              style={StyleSheet.absoluteFill}
            />

            <View style={[styles.card, styles.cardGlass, styles.modalCard]}>
              <Text style={styles.panelKicker}>Program</Text>
              <Text style={styles.panelTitle}>Choose a built-in program</Text>
              <Text style={styles.panelSub}>
                Pick the runtime preset you want the app to build. Switching to{' '}
                <Text style={styles.inlineCode}>curve</Text> also reveals the{' '}
                <Text style={styles.inlineCode}>.sbgf</Text> editor.
              </Text>

              <View style={styles.programPickerList}>
                {(['drop', 'sigmoid', 'slide', 'curve'] as ProgramKind[]).map(
                  nextKind => (
                    <Pressable
                      key={nextKind}
                      onPress={() => {
                        setProgramKind(nextKind);
                        setRuntimeMode('program');
                        setIsProgramPickerVisible(false);
                        setDiagnostics([]);
                        setCurveInfo(null);
                        setPreviewState(null);
                        setValidationState(
                          `Program set to ${programKindLabel(nextKind)}.`,
                        );
                      }}
                      style={({ pressed }) => [
                        styles.card,
                        styles.browserEntryCard,
                        nextKind === programKind && styles.programOptionActive,
                        pressed && styles.buttonPressed,
                      ]}
                    >
                      <View style={styles.browserEntryHeader}>
                        <Text style={styles.browserEntryTitle}>
                          {programKindLabel(nextKind)}
                        </Text>
                        <Text style={styles.browserEntryBadge}>
                          {nextKind === 'curve' ? '.sbgf' : 'built-in'}
                        </Text>
                      </View>
                      <Text style={styles.browserEntryMeta}>
                        {nextKind === 'curve'
                          ? 'Uses the .sbgf editor and curve solve data.'
                          : 'Uses the built-in program argument field only.'}
                      </Text>
                    </Pressable>
                  ),
                )}
              </View>

              <View style={styles.buttonRow}>
                <ActionButton
                  label="Close"
                  onPress={() => {
                    setIsProgramPickerVisible(false);
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
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.025,
    shadowRadius: 12,
    elevation: 1,
  },
  cardSoft: {
    backgroundColor: SURFACE_SOFT,
  },
  cardGlass: {
    backgroundColor: SURFACE_GLASS,
    borderColor: SURFACE_BORDER_LIGHT,
    borderWidth: 0,
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  heroCard: {
    overflow: 'hidden',
    paddingHorizontal: 20,
    paddingVertical: 22,
  },
  heroAccentBlue: {
    position: 'absolute',
    top: -72,
    left: -88,
    width: 268,
    height: 268,
    opacity: 0.52,
    resizeMode: 'stretch',
  },
  heroAccentPink: {
    position: 'absolute',
    right: -86,
    top: -84,
    width: 260,
    height: 260,
    opacity: 0.48,
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
  inputDisabled: {
    color: 'rgba(20, 20, 20, 0.42)',
    opacity: 0.75,
  },
  radioGroup: {
    gap: 10,
    marginBottom: 4,
  },
  radioCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.10)',
    backgroundColor: 'rgba(255, 255, 255, 0.60)',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  radioCardActive: {
    borderColor: 'rgba(58, 124, 255, 0.24)',
    backgroundColor: 'rgba(58, 124, 255, 0.12)',
  },
  radioIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(20, 20, 20, 0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  radioIndicatorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'transparent',
  },
  radioIndicatorDotActive: {
    backgroundColor: '#2b67de',
  },
  radioCopy: {
    flex: 1,
  },
  radioLabel: {
    color: '#141414',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 3,
  },
  radioSub: {
    color: 'rgba(20, 20, 20, 0.66)',
    fontSize: 13,
    lineHeight: 18,
  },
  selectField: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(0, 0, 0, 0.12)',
    backgroundColor: 'rgba(255, 255, 255, 0.75)',
    marginBottom: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  selectFieldValue: {
    color: '#141414',
    fontSize: 15,
    fontWeight: '700',
  },
  selectFieldChevron: {
    color: 'rgba(20, 20, 20, 0.54)',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  inlineField: {
    marginBottom: 2,
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
  documentActionRow: {
    justifyContent: 'center',
  },
  modalScrim: {
    flex: 1,
    backgroundColor: 'rgba(10, 12, 18, 0.48)',
    justifyContent: 'center',
    paddingHorizontal: 18,
    paddingVertical: 24,
  },
  modalCard: {
    backgroundColor: 'rgba(238, 238, 232, 0.90)',
    borderColor: 'rgba(255, 255, 255, 0.20)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.12,
    shadowRadius: 28,
    elevation: 10,
    maxHeight: '82%',
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  programPickerList: {
    marginBottom: 12,
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
    backgroundColor: 'rgba(232, 232, 226, 0.72)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderWidth: 0,
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  browserUpCard: {
    marginBottom: 10,
  },
  programOptionActive: {
    backgroundColor: 'rgba(58, 124, 255, 0.20)',
    borderColor: 'rgba(58, 124, 255, 0.24)',
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
