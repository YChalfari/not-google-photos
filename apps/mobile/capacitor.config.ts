import type { CapacitorConfig } from '@capacitor/cli';

// Baked in by `cap sync`. CI never sets this, so a release loads the bundled web app.
const devServer = process.env.CI ? undefined : process.env.CAP_SERVER_URL;

const config: CapacitorConfig = {
  appId: 'com.notgooglephotos.app',
  appName: 'Not Google Photos',
  webDir: '../web/dist',
  android: {
    // Dev live-reload can still be an https page talking to an http server.
    allowMixedContent: true,
  },
  server: {
    // http on purpose. Android WebView blocks <img> and <video> from https://localhost to an
    // http home server, even with allowMixedContent. Fetch is only warned. http://localhost is
    // still a secure context, and it is already allowed by the server's CORS list.
    androidScheme: 'http',
    ...(devServer ? { url: devServer, cleartext: devServer.startsWith('http://') } : {}),
  },
};

export default config;
