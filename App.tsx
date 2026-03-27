import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ValidationWorkbench } from './src/ui/ValidationWorkbench';

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <ValidationWorkbench />
    </SafeAreaProvider>
  );
}

export default App;
