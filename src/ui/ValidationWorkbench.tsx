import { useEffect, useMemo, useState } from 'react';
import {
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

  async function refreshDocuments() {
    setDocuments(await listDocuments());
  }

  async function runValidation() {
    setIsValidating(true);

    try {
      const result = await validateDocument(
        documentKind,
        text,
        ensureDocumentName(fileName, documentKind),
      );

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
      const nextContext = await prepareSbgContext(
        text,
        ensureDocumentName(fileName, documentKind),
      );
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
      const nextContext = await prepareSbgContext(
        text,
        ensureDocumentName(fileName, documentKind),
      );
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
      const nextState = await startPlayback(
        text,
        ensureDocumentName(fileName, documentKind),
      );
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
      const saved = await saveDocument(
        ensureDocumentName(fileName, documentKind),
        text,
      );
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
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.heroCard}>
          <Text style={styles.eyebrow}>ANDROID NATIVE BRIDGE</Text>
          <Text style={styles.title}>SBaGenX Editor Workbench</Text>
          <Text style={styles.subtitle}>
            Validation, persistent render context, native preview rendering,
            Android playback, and app-local save/load are now on the same
            screen.
          </Text>
        </View>

        <View style={styles.infoRow}>
          <View style={styles.infoCard}>
            <Text style={styles.infoLabel}>Bridge</Text>
            <Text style={styles.infoValue}>
              {bridgeInfo
                ? `v${bridgeInfo.bridgeVersion}`
                : nativeAvailability
                ? 'Loading...'
                : 'Unavailable'}
            </Text>
          </View>
          <View style={styles.infoCard}>
            <Text style={styles.infoLabel}>sbagenxlib</Text>
            <Text style={styles.infoValue}>
              {bridgeInfo ? bridgeInfo.libraryVersion : 'pending'}
            </Text>
          </View>
          <View style={styles.infoCard}>
            <Text style={styles.infoLabel}>Playback</Text>
            <Text style={styles.infoValue}>
              {playbackState?.active ? 'Running' : 'Stopped'}
            </Text>
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Document</Text>
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
            style={styles.fileNameInput}
            value={fileName}
          />

          <View style={styles.actionRow}>
            <Pressable
              onPress={() => loadPreset(documentKind, 'sample')}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Load Valid Sample</Text>
            </Pressable>
            <Pressable
              onPress={() => loadPreset(documentKind, 'broken')}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Load Broken Sample</Text>
            </Pressable>
            <Pressable
              disabled={isSaving}
              onPress={handleSaveDocument}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>
                {isSaving ? 'Saving...' : 'Save Draft'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                refreshDocuments().catch(() => {});
              }}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Refresh Drafts</Text>
            </Pressable>
            <Pressable
              disabled={isValidating}
              onPress={runValidation}
              style={[
                styles.primaryButton,
                isValidating && styles.primaryButtonDisabled,
              ]}
            >
              <Text style={styles.primaryButtonText}>
                {isValidating ? 'Validating...' : 'Validate Natively'}
              </Text>
            </Pressable>
          </View>

          <Text style={styles.editorHint}>
            Save name resolves to: {ensureDocumentName(fileName, documentKind)}
          </Text>
          <TextInput
            multiline
            onChangeText={setText}
            style={styles.editor}
            textAlignVertical="top"
            value={text}
          />
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Render And Playback</Text>
          <View style={styles.actionRow}>
            <Pressable
              disabled={isPreparing}
              onPress={() => {
                handlePrepareContext().catch(() => {});
              }}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>
                {isPreparing ? 'Preparing...' : 'Prepare Context'}
              </Text>
            </Pressable>
            <Pressable
              disabled={isRendering}
              onPress={() => {
                handleRenderPreview().catch(() => {});
              }}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>
                {isRendering ? 'Rendering...' : 'Render Preview'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                handleResetContext().catch(() => {});
              }}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Reset Context</Text>
            </Pressable>
            <Pressable
              disabled={isPlayingAction}
              onPress={() => {
                handleStartPlayback().catch(() => {});
              }}
              style={[
                styles.primaryButton,
                isPlayingAction && styles.primaryButtonDisabled,
              ]}
            >
              <Text style={styles.primaryButtonText}>Play</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                handleStopPlayback().catch(() => {});
              }}
              style={styles.secondaryButton}
            >
              <Text style={styles.secondaryButtonText}>Stop</Text>
            </Pressable>
          </View>

          <View style={styles.infoRow}>
            <View style={styles.infoCard}>
              <Text style={styles.infoLabel}>Prepared</Text>
              <Text style={styles.infoValue}>
                {contextState?.prepared ? 'Yes' : 'No'}
              </Text>
            </View>
            <View style={styles.infoCard}>
              <Text style={styles.infoLabel}>Runtime Time</Text>
              <Text style={styles.infoValue}>
                {contextState ? formatSeconds(contextState.timeSec) : '--'}
              </Text>
            </View>
            <View style={styles.infoCard}>
              <Text style={styles.infoLabel}>Duration</Text>
              <Text style={styles.infoValue}>
                {contextState ? formatSeconds(contextState.durationSec) : '--'}
              </Text>
            </View>
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
            <View style={styles.previewCard}>
              <Text style={styles.previewTitle}>Preview Buffer</Text>
              <Text style={styles.previewMeta}>
                {previewState.frameCount} frames, peak{' '}
                {previewState.peakAbs.toFixed(3)}, rms{' '}
                {previewState.rms.toFixed(3)}
              </Text>
              <Text style={styles.previewSamples}>{samplePreview}</Text>
            </View>
          ) : (
            <Text style={styles.emptyState}>
              Render preview to smoke-test PCM generation before playback.
            </Text>
          )}
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Diagnostics</Text>
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
              sample to exercise the bridge.
            </Text>
          ) : (
            diagnostics.map(diagnostic => (
              <View
                key={`${diagnostic.code}-${formatSpan(diagnostic)}`}
                style={styles.diagnosticCard}
              >
                <View style={styles.diagnosticHeader}>
                  <Text
                    style={[
                      styles.diagnosticSeverity,
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

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Saved Drafts</Text>
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
                style={styles.documentCard}
              >
                <Text style={styles.documentName}>{document.name}</Text>
                <Text style={styles.documentMeta}>
                  {formatBytes(document.sizeBytes)} •{' '}
                  {new Date(document.modifiedAtMs).toLocaleString()}
                </Text>
              </Pressable>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#f4efe3',
  },
  scrollView: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 28,
  },
  heroCard: {
    backgroundColor: '#103349',
    borderRadius: 28,
    paddingHorizontal: 20,
    paddingVertical: 22,
    marginBottom: 14,
  },
  eyebrow: {
    color: '#ffd36b',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.4,
    marginBottom: 10,
  },
  title: {
    color: '#fff8eb',
    fontSize: 30,
    fontWeight: '800',
    lineHeight: 34,
    marginBottom: 10,
  },
  subtitle: {
    color: '#c7d7df',
    fontSize: 15,
    lineHeight: 22,
  },
  infoRow: {
    flexDirection: 'row',
    marginBottom: 14,
  },
  infoCard: {
    flex: 1,
    backgroundColor: '#fff9ef',
    borderColor: '#d7c7ab',
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginRight: 10,
  },
  infoLabel: {
    color: '#8b6f4d',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  infoValue: {
    color: '#142531',
    fontSize: 16,
    fontWeight: '700',
  },
  panel: {
    backgroundColor: '#fff9ef',
    borderColor: '#d7c7ab',
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginBottom: 14,
  },
  panelTitle: {
    color: '#142531',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 12,
  },
  fieldLabel: {
    color: '#5a4630',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  fileNameInput: {
    backgroundColor: '#fffdf7',
    borderColor: '#d7c7ab',
    borderRadius: 14,
    borderWidth: 1,
    color: '#102430',
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  segmentRow: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  segmentButton: {
    flex: 1,
    backgroundColor: '#efe4cf',
    borderRadius: 14,
    marginRight: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  segmentButtonActive: {
    backgroundColor: '#ef6b43',
  },
  segmentButtonText: {
    color: '#5a4630',
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  segmentButtonTextActive: {
    color: '#fff9ef',
  },
  actionRow: {
    marginBottom: 12,
  },
  secondaryButton: {
    backgroundColor: '#efe4cf',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
  },
  secondaryButtonText: {
    color: '#43311f',
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: '#103349',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  primaryButtonDisabled: {
    opacity: 0.7,
  },
  primaryButtonText: {
    color: '#fff8eb',
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
  editorHint: {
    color: '#7a6248',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
  },
  editor: {
    minHeight: 260,
    backgroundColor: '#fffdf7',
    borderColor: '#d7c7ab',
    borderRadius: 18,
    borderWidth: 1,
    color: '#102430',
    fontFamily: 'monospace',
    fontSize: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  statusLine: {
    color: '#5a4630',
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
  },
  inlineError: {
    color: '#8a1f11',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  previewCard: {
    backgroundColor: '#fffdf7',
    borderColor: '#d7c7ab',
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  previewTitle: {
    color: '#132530',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 6,
  },
  previewMeta: {
    color: '#7a6248',
    fontSize: 13,
    marginBottom: 8,
  },
  previewSamples: {
    color: '#243742',
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
  },
  errorCard: {
    backgroundColor: '#ffe6de',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 12,
  },
  errorTitle: {
    color: '#7d1f10',
    fontSize: 14,
    fontWeight: '800',
    marginBottom: 6,
  },
  errorBody: {
    color: '#7d1f10',
    fontSize: 14,
    lineHeight: 20,
  },
  emptyState: {
    color: '#7a6248',
    fontSize: 15,
    lineHeight: 22,
  },
  diagnosticCard: {
    backgroundColor: '#fffdf7',
    borderColor: '#d7c7ab',
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 10,
  },
  diagnosticHeader: {
    marginBottom: 8,
  },
  diagnosticSeverity: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 11,
    fontWeight: '900',
    marginBottom: 8,
  },
  errorBadge: {
    backgroundColor: '#ffd8cf',
    color: '#8a1f11',
  },
  warningBadge: {
    backgroundColor: '#ffe79d',
    color: '#6f5200',
  },
  diagnosticCode: {
    color: '#132530',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 4,
  },
  diagnosticSpan: {
    color: '#7a6248',
    fontFamily: 'monospace',
    fontSize: 12,
  },
  diagnosticMessage: {
    color: '#243742',
    fontSize: 15,
    lineHeight: 22,
  },
  documentCard: {
    backgroundColor: '#fffdf7',
    borderColor: '#d7c7ab',
    borderRadius: 18,
    borderWidth: 1,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  documentName: {
    color: '#132530',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 4,
  },
  documentMeta: {
    color: '#7a6248',
    fontSize: 12,
  },
});
