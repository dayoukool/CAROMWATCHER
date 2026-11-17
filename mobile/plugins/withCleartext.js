// Autorise l'application à parler en HTTP au Raspberry Pi sur le réseau local
// (Android bloque le HTTP non chiffré par défaut depuis Android 9).
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withCleartext(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    app.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
};
