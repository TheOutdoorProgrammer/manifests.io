import { defineConfig } from 'vitest/config';
import { loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import faroUploader from '@grafana/faro-rollup-plugin';
import { buildTelemetry } from './src/buildTelemetry.ts';

export default defineConfig(({ isSsrBuild, mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const release = env.VITE_APP_VERSION || 'development';
  const telemetry = buildTelemetry(env);
  const assetBase = env.VITE_STATIC_BUILD === '1' ? `/releases/${release}/` : '/';
  return {
    base: assetBase,
    plugins: [react(), ...(!isSsrBuild ? [faroUploader({
      appName: telemetry.app,
      // The plugin requires these options even when uploads are disabled.
      endpoint: '',
      appId: '',
      stackId: '',
      apiKey: '',
      bundleId: release,
      gitHash: /^[a-f0-9]{40}$/.test(release) ? release : undefined,
      skipUpload: true,
      prefixPath: `${telemetry.origin}${assetBase}assets/`,
      prefixPathBasenameOnly: true,
    })] : [])],
    publicDir: '../public',
    build: { manifest: true, sourcemap: isSsrBuild ? false : 'hidden' },
    server: {
      proxy: { '/api': 'http://localhost:8080' },
      watch: { ignored: ['**/dist-server/**', '**/prerender*/**'] },
    },
    test: { environment: 'jsdom', setupFiles: ['./src/test-setup.ts'], include: ['src/**/*.test.{ts,tsx}'] },
  };
});
