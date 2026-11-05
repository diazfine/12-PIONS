import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pions12.app',
  appName: 'D 12 PIONS',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#042f2e',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#083023',
      overlaysWebView: true,
    },
    ScreenOrientation: {
      orientation: 'PORTRAIT',
    },
    GoogleAuth: {
      scopes: ['profile', 'email'],
      serverClientId: '1092837465-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com',
      forceCodeForRefreshToken: true,
    },
    FacebookLogin: {
      appId: '123456789012345',
      autoLogAppEvents: true,
      xfbml: true,
    },
  },
};

export default config;
