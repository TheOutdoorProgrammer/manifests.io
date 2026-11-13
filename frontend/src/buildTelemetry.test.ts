import { expect, it } from 'vitest'
import { buildTelemetry } from './buildTelemetry'

it('keeps production defaults and permits only the explicit immutable preview pair', () => {
  expect(buildTelemetry({}).app).toBe('Manifests.io')
  expect(buildTelemetry({}).collector).toBe('https://rum.stout.zone/collect/84a6beb18042862a3436000826d8a36f')
  const preview = { VITE_FARO_APP_NAME: 'manifests-preview', VITE_APP_VERSION: 'a'.repeat(40) }
  expect(buildTelemetry(preview).collector).toBe('https://rum.stout.zone/collect/manifests-preview')
  for (const changed of [
    { VITE_APP_VERSION: 'development' }, { VITE_STATIC_BUILD: '1' },
    { VITE_FARO_APP_NAME: 'arbitrary-app' }, { VITE_FARO_URL: 'https://private.invalid/collect' },
    { VITE_FARO_URL: 'https://user:secret@rum.stout.zone/collect/manifests-preview' },
    { VITE_FARO_URL: 'https://rum.stout.zone/collect/manifests-preview?secret=value' },
    { VITE_FARO_URL: buildTelemetry({}).collector },
  ]) expect(() => buildTelemetry({ ...preview, ...changed })).toThrow()
  expect(buildTelemetry({ VITE_FARO_URL: 'http://localhost:4318/collect' }).collector).toBe('http://localhost:4318/collect')
})
