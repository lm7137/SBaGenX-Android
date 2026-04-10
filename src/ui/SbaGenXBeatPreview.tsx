import {
  requireNativeComponent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { BeatPreviewResult } from '../native/sbagenx';

type NativeSbaGenXBeatPreviewProps = {
  darkMode?: boolean;
  preview?: BeatPreviewResult | null;
  style?: StyleProp<ViewStyle>;
};

const NativeSbaGenXBeatPreview =
  requireNativeComponent<NativeSbaGenXBeatPreviewProps>(
    'SbaGenXBeatPreviewView',
  );

export function SbaGenXBeatPreview(props: NativeSbaGenXBeatPreviewProps) {
  return <NativeSbaGenXBeatPreview {...props} />;
}
