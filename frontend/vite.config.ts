import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import faroUploader from '@grafana/faro-rollup-plugin';

const release = process.env.VITE_APP_VERSION || 'development';
const assetBase = process.env.VITE_STATIC_BUILD === '1' ? `/releases/${release}/` : '/';

export default defineConfig(({ isSsrBuild }) => ({
  base: assetBase,
  plugins: [react(), ...(!isSsrBuild ? [faroUploader({
    appName: 'Manifests.io',
    // The plugin requires these options even when uploads are disabled.
    endpoint: '',
    appId: '',
    stackId: '',
    apiKey: '',
    bundleId: release,
    gitHash: /^[a-f0-9]{40}$/.test(release) ? release : undefined,
    skipUpload: true,
    prefixPath: `https://www.manifests.io${assetBase}assets/`,
    prefixPathBasenameOnly: true,
  })] : [])],
  publicDir: '../public',
  build: { manifest: true, sourcemap: isSsrBuild ? false : 'hidden' },
  server: {
    proxy: { '/api': 'http://localhost:8080' },
    watch: { ignored: ['**/dist-server/**', '**/prerender*/**'] },
  },
  test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
}));
