// Coquille React Native : affiche l'application web (moteur + interface) dans une WebView
// et lui fournit ce que le navigateur fait mal : autorisation caméra, écran allumé, vibration, zones système.
// mixedContentMode + usesCleartextTraffic (plugins/withCleartext.js) : la page HTTPS peut joindre le Pi en HTTP local.
import React, { useEffect } from 'react';
import { PermissionsAndroid, Platform, StyleSheet, Vibration } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useKeepAwake } from 'expo-keep-awake';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import appHtml from './web/appHtml';

// Origine HTTPS fictive : la page est un « contexte sécurisé », condition pour accéder à la caméra.
// Elle sert aussi de clé au stockage local (historique, calibrage).
const BASE_URL = 'https://carambole.local/';

function onMessage(event) {
  let msg;
  try { msg = JSON.parse(event.nativeEvent.data); } catch (e) { return; }
  if (msg.type === 'vibrate' && Array.isArray(msg.pattern)) {
    // Web : [vibre, pause, vibre…] ; Android : [attente, vibre, pause, vibre…]
    Vibration.vibrate([0, ...msg.pattern]);
  }
}

export default function App() {
  useKeepAwake(); // l'écran ne s'éteint pas pendant qu'on filme

  useEffect(() => {
    if (Platform.OS === 'android') {
      PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
        title: 'Accès à la caméra',
        message: 'Carambole filme la table pour suivre les billes et valider les points.',
        buttonPositive: 'Autoriser',
        buttonNegative: 'Plus tard',
      }).catch(() => {});
    }
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
        <StatusBar style="light" />
        <WebView
          style={styles.web}
          source={{ html: appHtml, baseUrl: BASE_URL }}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          allowFileAccess
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          mediaCapturePermissionGrantType="grant"
          mixedContentMode="always"
          setSupportMultipleWindows={false}
          onMessage={onMessage}
          webviewDebuggingEnabled={__DEV__}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0d1311' },
  web: { flex: 1, backgroundColor: '#0d1311' },
});
