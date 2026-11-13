const productionCollector = 'https://rum.stout.zone/collect/84a6beb18042862a3436000826d8a36f'
const previewCollector = 'https://rum.stout.zone/collect/manifests-preview'

export function buildTelemetry(env: Record<string, string | undefined>) {
  const app = env.VITE_FARO_APP_NAME || 'Manifests.io'
  if (app !== 'Manifests.io' && app !== 'manifests-preview') throw new Error('Invalid browser app identity')
  const expected = app === 'Manifests.io' ? productionCollector : previewCollector
  const collector = env.VITE_FARO_URL || expected
  const url = new URL(collector)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash ||
      (collector !== expected && !(loopback && ['http:', 'https:'].includes(url.protocol)))) {
    throw new Error('Invalid browser collector')
  }
  if (app === 'manifests-preview' && (env.VITE_STATIC_BUILD === '1' ||
      !/^[a-f0-9]{40}$/.test(env.VITE_APP_VERSION || '') || collector !== expected)) {
    throw new Error('Preview requires its immutable server build')
  }
  return { app, collector, origin: app === 'Manifests.io' ? 'https://www.manifests.io' : 'https://manifests-preview-155511170166.us-east1.run.app' }
}
