/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  output: 'standalone',
  experimental: {
    cpus: 1,
  },
  webpack(config) {
    // @aws-sdk/client-s3 is an optional runtime dependency (only used when
    // STORAGE_DRIVER=s3). Tell webpack not to bundle it — it will be require()d
    // at runtime when needed.
    config.externals = [...(config.externals || []), '@aws-sdk/client-s3'];
    return config;
  },
};
