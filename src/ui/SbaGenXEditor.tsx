import {
  requireNativeComponent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { SbaGenXDiagnostic } from '../native/sbagenx';

type EditorTextChangeEvent = {
  text: string;
};

type NativeSbaGenXEditorProps = {
  darkMode?: boolean;
  diagnostics?: readonly SbaGenXDiagnostic[];
  editable?: boolean;
  onTextChange?: (
    event: NativeSyntheticEvent<EditorTextChangeEvent>,
  ) => void;
  placeholder?: string;
  style?: StyleProp<ViewStyle>;
  text: string;
};

const NativeSbaGenXEditor =
  requireNativeComponent<NativeSbaGenXEditorProps>('SbaGenXEditorView');

export function SbaGenXEditor(props: NativeSbaGenXEditorProps) {
  return <NativeSbaGenXEditor {...props} />;
}
