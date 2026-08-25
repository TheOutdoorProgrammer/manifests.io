/** @type {import('next').NextConfig} */
const {execFileSync} = require('node:child_process')
const FaroSourceMapUploaderPlugin = require('@grafana/faro-webpack-plugin')

function resolveGitHash() {
  const buildHash = process.env.WORKERS_CI_COMMIT_SHA || process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA
  if (/^[0-9a-f]{40}$/.test(buildHash || '')) return buildHash

  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()
  } catch {
    return undefined
  }
}

const gitHash = resolveGitHash()

const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
  productionBrowserSourceMaps: true,
  env: gitHash ? {NEXT_PUBLIC_GIT_HASH: gitHash} : {},
  webpack: (config, {isServer}) => {
    if (!isServer && process.env.FARO_SOURCEMAP_API_KEY) {
      config.plugins.push(new FaroSourceMapUploaderPlugin({
        appName: 'Manifests.io',
        endpoint: 'https://faro-api-prod-us-east-3.grafana.net/faro/api/v1',
        appId: '848',
        stackId: '1807923',
        apiKey: process.env.FARO_SOURCEMAP_API_KEY,
        gitHash,
        gzipContents: true,
        nextjs: true,
        outputFiles: /^static\/.*\.js\.map$/,
        recursive: true,
        verbose: true,
      }))
    }

    return config
  },
  headers: async () => {
    return [
        {
          source: '/(.*)',
          headers: [
            {
              key: 'Cache-Control',
              value: 'public, max-age=604800, stale-while-revalidate=86400'
            }
          ]
        }
    ]
  }
};

module.exports = nextConfig
