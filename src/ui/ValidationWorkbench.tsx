import { useEffect, useMemo, useState } from 'react';
import {
  Image,
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
  getPlaybackState,
  inferDocumentKind,
  isNativeBridgeAvailable,
  listDocuments,
  loadDocument,
  prepareSbgContext,
  renderPreview,
  resetContext,
  saveDocument,
  startPlayback,
  stopPlayback,
  type BridgeInfo,
  type ContextState,
  type DocumentKind,
  type PlaybackState,
  type RenderPreviewResult,
  type SavedDocumentSummary,
  type SbaGenXDiagnostic,
  validateDocument,
} from '../native/sbagenx';

const brandIcon = require('../assets/sbagenx-icon.png');
const backgroundTile = require('../assets/bg-tile.gif');

const VALID_SBG_SAMPLE =
  '00:00    200+10/20 step\n00:30    190+8/20\n01:00    180+6/20\n';

const INVALID_SBG_SAMPLE = '-SE\n-Z nope\n\nalloff: -\n\nNOW alloff\n';

const VALID_SBGF_SAMPLE =
  '# SBaGenX custom curve example (.sbgf)\n' +
  'param l = 0.15\n' +
  'solve A,C : A*exp(-l*0)+C=b0 ; A*exp(-l*D)+C=b1\n\n' +
  'beat = A*exp(-l*m) + C\n' +
  'carrier = c0 + (c1-c0) * ramp(m,0,T)\n';

const INVALID_SBGF_SAMPLE = 'title "broken"\nbeat =\n';

const DOCUMENT_PRESETS: Record<
  DocumentKind,
  { sample: string; broken: string; sourceName: string }
> = {
  sbg: {
    sample: VALID_SBG_SAMPLE,
    broken: INVALID_SBG_SAMPLE,
    sourceName: 'scratch.sbg',
  },
  sbgf: {
    sample: VALID_SBGF_SAMPLE,
    broken: INVALID_SBGF_SAMPLE,
    sourceName: 'scratch.sbgf',
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

type HeroChipProps = {
  label: string;
};

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

function HeroChip({ label }: HeroChipProps) {
  return (
    <View style={styles.heroChip}>
      <Text style={styles.heroChipText}>{label}</Text>
    </View>
  );
}

export function ValidationWorkbench() {
  const [documentKind, setDocumentKind] = useState<DocumentKind>('sbg');
  const [fileName, setFileName] = useState('scratch.sbg');
  const [text, setText] = useState(DOCUMENT_PRESETS.sbg.sample);
  const [bridgeInfo, setBridgeInfo] = useState<BridgeInfo | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [validationState, setValidationState] = useState(
    'Bridge ready check pending.',
  );
  const [diagnostics, setDiagnostics] = useState<SbaGenXDiagnostic[]>([]);
  const [contextState, setContextState] = useState<ContextState | null>(null);
  const [previewState, setPreviewState] = useState<RenderPreviewResult | null>(
    null,
  );
  const [playbackState, setPlaybackState] = useState<PlaybackState | null>(
    null,
  );
  const [documents, setDocuments] = useState<SavedDocumentSummary[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isPlayingAction, setIsPlayingAction] = useState(false);

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
        const [docs, playback, context] = await Promise.all([
          listDocuments(),
          getPlaybackState(),
          getContextState(),
        ]);

        if (cancelled) {
          return;
        }

        setDocuments(docs);
        setPlaybackState(playback);
        setContextState(context);
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

  async function refreshDocuments() {
    setDocuments(await listDocuments());
  }

  async function runValidation() {
    setIsValidating(true);

    try {
      const result = await validateDocument(documentKind, text, resolvedName);

      setDiagnostics(result.diagnostics);
      setBridgeError(null);

      if (result.status !== 0) {
        setValidationState(
          `Native status ${result.status} (${result.statusText}).`,
        );
      } else if (result.diagnosticCount === 0) {
        setValidationState('Validation passed with no diagnostics.');
      } else {
        setValidationState(
          `Validation returned ${result.diagnosticCount} diagnostic${
            result.diagnosticCount === 1 ? '' : 's'
          }.`,
        );
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown validation error.';
      setBridgeError(message);
      setValidationState('Validation failed before diagnostics were returned.');
    } finally {
      setIsValidating(false);
    }
  }

  async function handlePrepareContext() {
    if (documentKind !== 'sbg') {
      setValidationState(
        'Render context preparation is only available for .sbg.',
      );
      return;
    }

    setIsPreparing(true);

    try {
      const nextContext = await prepareSbgContext(text, resolvedName);
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

  async function handleStartPlayback() {
    if (documentKind !== 'sbg') {
      setValidationState('Playback is only available for .sbg.');
      return;
    }

    setIsPlayingAction(true);

    try {
      const nextState = await startPlayback(text, resolvedName);
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
      await refreshDocuments();
      setValidationState(`Saved ${saved.name} to app-local storage.`);
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
      setText(loaded.text);
      setDiagnostics([]);
      setPreviewState(null);
      setValidationState(`Loaded ${loaded.name} from app-local storage.`);
    } catch (error) {
      setBridgeError(
        error instanceof Error ? error.message : 'Failed to load document.',
      );
    }
  }

  function loadPreset(nextKind: DocumentKind, preset: 'sample' | 'broken') {
    setDocumentKind(nextKind);
    setFileName(DOCUMENT_PRESETS[nextKind].sourceName);
    setText(DOCUMENT_PRESETS[nextKind][preset]);
    setDiagnostics([]);
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

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.root}>
        <View pointerEvents="none" style={styles.backgroundTileWrap}>
          <Image
            resizeMode="repeat"
            source={backgroundTile}
            style={styles.backgroundTile}
          />
        </View>
        <View pointerEvents="none" style={styles.backgroundOverlay} />
        <View pointerEvents="none" style={[styles.backgroundOrb, styles.blueOrb]} />
        <View pointerEvents="none" style={[styles.backgroundOrb, styles.pinkOrb]} />
        <View pointerEvents="none" style={[styles.backgroundOrb, styles.bottomOrb]} />

        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={[styles.card, styles.cardSoft, styles.heroCard]}>
            <View style={styles.heroAccentBlue} />
            <View style={styles.heroAccentPink} />

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
            </View>

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
          </View>

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

          <View style={[styles.card, styles.cardGlass, styles.panel]}>
            <Text style={styles.panelKicker}>Document</Text>
            <Text style={styles.panelTitle}>Editor and samples</Text>
            <Text style={styles.panelSub}>
              Switch between timing and curve documents, load samples, save
              local drafts, and validate against the native library.
            </Text>

            <View style={styles.segmentRow}>
              <Pressable
                onPress={() => loadPreset('sbg', 'sample')}
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
                onPress={() => loadPreset('sbgf', 'sample')}
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
                label="Load Valid Sample"
                onPress={() => loadPreset(documentKind, 'sample')}
              />
              <ActionButton
                label="Load Broken Sample"
                onPress={() => loadPreset(documentKind, 'broken')}
              />
              <ActionButton
                disabled={isSaving}
                label={isSaving ? 'Saving...' : 'Save Draft'}
                onPress={handleSaveDocument}
              />
              <ActionButton
                label="Refresh Drafts"
                onPress={() => {
                  refreshDocuments().catch(() => {});
                }}
              />
              <ActionButton
                disabled={isValidating}
                label={isValidating ? 'Validating...' : 'Validate Natively'}
                onPress={runValidation}
                tone="primary"
              />
            </View>

            <Text style={styles.note}>
              Save name resolves to:{' '}
              <Text style={styles.inlineCode}>{resolvedName}</Text>
            </Text>

            <TextInput
              multiline
              onChangeText={setText}
              style={styles.editor}
              textAlignVertical="top"
              value={text}
            />
          </View>

          <View style={[styles.card, styles.cardSoft, styles.panel]}>
            <Text style={styles.panelKicker}>Runtime</Text>
            <Text style={styles.panelTitle}>Render and playback</Text>
            <Text style={styles.panelSub}>
              Prepare a persistent native context, render a preview buffer, and
              run Android playback for <Text style={styles.inlineCode}>.sbg</Text>{' '}
              timing documents.
            </Text>

            <View style={styles.buttonRow}>
              <ActionButton
                disabled={isPreparing}
                label={isPreparing ? 'Preparing...' : 'Prepare Context'}
                onPress={() => {
                  handlePrepareContext().catch(() => {});
                }}
              />
              <ActionButton
                disabled={isRendering}
                label={isRendering ? 'Rendering...' : 'Render Preview'}
                onPress={() => {
                  handleRenderPreview().catch(() => {});
                }}
              />
              <ActionButton
                label="Reset Context"
                onPress={() => {
                  handleResetContext().catch(() => {});
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
            </View>

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

            <Text style={styles.statusLine}>
              {playbackState?.active
                ? `Playback active at ${formatSeconds(
                    playbackState.timeSec,
                  )} of ${formatSeconds(playbackState.durationSec)}.`
                : 'Playback is idle.'}
            </Text>

            {playbackState?.lastError ? (
              <Text style={styles.inlineError}>{playbackState.lastError}</Text>
            ) : null}

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
                Render preview to smoke-test PCM generation before playback.
              </Text>
            )}
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

            {diagnostics.length === 0 ? (
              <Text style={styles.emptyState}>
                No diagnostics recorded yet. Run validation or load a broken
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

          <View style={[styles.card, styles.cardSoft, styles.panel]}>
            <Text style={styles.panelKicker}>Storage</Text>
            <Text style={styles.panelTitle}>Saved drafts</Text>
            <Text style={styles.panelSub}>
              App-local drafts are the current first document flow until Android
              system document pickers are added.
            </Text>

            {documents.length === 0 ? (
              <Text style={styles.emptyState}>
                No app-local drafts yet. Save one from the editor to make this a
                usable first document flow.
              </Text>
            ) : (
              documents.map(document => (
                <Pressable
                  key={document.name}
                  onPress={() => {
                    handleLoadDocument(document.name).catch(() => {});
                  }}
                  style={({ pressed }) => [
                    styles.card,
                    styles.documentCard,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <View style={styles.documentCardRow}>
                    <Text style={styles.documentName}>{document.name}</Text>
                    <Text style={styles.documentSize}>
                      {formatBytes(document.sizeBytes)}
                    </Text>
                  </View>
                  <Text style={styles.documentMeta}>
                    {formatTimestamp(document.modifiedAtMs)}
                  </Text>
                </Pressable>
              ))
            )}
          </View>
        </ScrollView>
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
  backgroundTileWrap: {
    ...StyleSheet.absoluteFillObject,
  },
  backgroundTile: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.34,
  },
  backgroundOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(246, 246, 242, 0.72)',
  },
  backgroundOrb: {
    position: 'absolute',
    borderRadius: 999,
  },
  blueOrb: {
    top: -70,
    left: -110,
    width: 300,
    height: 240,
    backgroundColor: 'rgba(58, 124, 255, 0.12)',
  },
  pinkOrb: {
    top: 40,
    right: -110,
    width: 260,
    height: 220,
    backgroundColor: 'rgba(255, 46, 166, 0.10)',
  },
  bottomOrb: {
    bottom: 80,
    left: 24,
    width: 220,
    height: 180,
    backgroundColor: 'rgba(58, 124, 255, 0.07)',
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
    borderColor: 'rgba(20, 20, 20, 0.12)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.1,
    shadowRadius: 24,
    elevation: 4,
  },
  cardSoft: {
    backgroundColor: 'rgba(255, 255, 255, 0.84)',
  },
  cardGlass: {
    backgroundColor: 'rgba(255, 255, 255, 0.74)',
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
    borderRadius: 999,
    backgroundColor: 'rgba(58, 124, 255, 0.10)',
  },
  heroAccentPink: {
    position: 'absolute',
    right: -36,
    top: -44,
    width: 170,
    height: 170,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 46, 166, 0.10)',
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
    minHeight: 300,
    backgroundColor: 'rgba(255, 255, 255, 0.75)',
    borderColor: 'rgba(0, 0, 0, 0.12)',
    borderRadius: 16,
    borderWidth: 1,
    color: '#141414',
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  statusLine: {
    color: 'rgba(20, 20, 20, 0.78)',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
  },
  inlineError: {
    color: '#9f1c23',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  innerGlassCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.70)',
    borderColor: 'rgba(0, 0, 0, 0.10)',
    paddingHorizontal: 14,
    paddingVertical: 14,
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
    backgroundColor: 'rgba(255, 255, 255, 0.74)',
    borderColor: 'rgba(20, 20, 20, 0.10)',
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
    backgroundColor: 'rgba(255, 255, 255, 0.70)',
    borderColor: 'rgba(0, 0, 0, 0.10)',
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
