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
  getBridgeInfo,
  isNativeBridgeAvailable,
  type BridgeInfo,
  type DocumentKind,
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

export function ValidationWorkbench() {
  const [documentKind, setDocumentKind] = useState<DocumentKind>('sbg');
  const [text, setText] = useState(DOCUMENT_PRESETS.sbg.sample);
  const [bridgeInfo, setBridgeInfo] = useState<BridgeInfo | null>(null);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [validationState, setValidationState] = useState(
    'Bridge ready check pending.',
  );
  const [diagnostics, setDiagnostics] = useState<SbaGenXDiagnostic[]>([]);
  const [isValidating, setIsValidating] = useState(false);

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

  const nativeAvailability = useMemo(() => isNativeBridgeAvailable(), []);

  async function runValidation() {
    setIsValidating(true);

    try {
      const result = await validateDocument(
        documentKind,
        text,
        DOCUMENT_PRESETS[documentKind].sourceName,
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

  function loadPreset(nextKind: DocumentKind, preset: 'sample' | 'broken') {
    setDocumentKind(nextKind);
    setText(DOCUMENT_PRESETS[nextKind][preset]);
    setDiagnostics([]);
    setValidationState(
      preset === 'sample'
        ? 'Loaded a valid sample document.'
        : 'Loaded a broken sample document.',
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.heroCard}>
          <Text style={styles.eyebrow}>ANDROID NATIVE BRIDGE</Text>
          <Text style={styles.title}>SBaGenX Validation Workbench</Text>
          <Text style={styles.subtitle}>
            React Native is driving the UI, but the parser and diagnostics come
            from the real `sbagenxlib` build through Kotlin and JNI.
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
            <Text style={styles.infoLabel}>API</Text>
            <Text style={styles.infoValue}>
              {bridgeInfo ? bridgeInfo.apiVersion : '--'}
            </Text>
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Document Type</Text>
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
            Source name: {DOCUMENT_PRESETS[documentKind].sourceName}
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
});
