import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.notgooglephotos.app',
  appName: 'Not Google Photos',
  webDir: 'dist',
  android: {
    // The bundled page is https://localhost, and a home server is often http://192.168.x.x.
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
