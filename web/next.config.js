/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  output: 'standalone',
  experimental: {
    cpus: 1,
  },
  webpack(config) {
    // Optional runtime dependencies — not installed, skip bundling.
    config.externals = [
      ...(config.externals || []),
      '@aws-sdk/client-s3',
      '@sentry/nextjs',
    ];
    return config;
  },
};
