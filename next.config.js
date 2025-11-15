/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  reactStrictMode: true,
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
}

module.exports = nextConfig
