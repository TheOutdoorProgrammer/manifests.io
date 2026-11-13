import { writeFile } from 'node:fs/promises';

// This describes the same Docker build that supplies the runnable assets.
if (process.env.VITE_FARO_APP_NAME === 'manifests-preview') {
  if (!/^[a-f0-9]{40}$/.test(process.env.VITE_APP_VERSION ?? '')) throw new Error('Immutable preview release required');
  await writeFile('dist/build-identity.json', `${JSON.stringify({
    app: 'manifests-preview', profile: 'preview-server', release: process.env.VITE_APP_VERSION,
  })}\n`, { flag: 'wx' });
}
