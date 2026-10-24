import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ph.cookiefluffs.app',
  appName: 'Cookie Fluffs',
  webDir: 'www',
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
};

export default config;
