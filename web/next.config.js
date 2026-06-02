/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  output: 'standalone',
  // These are optional runtime deps — don't bundle them.
  serverExternalPackages: ['@aws-sdk/client-s3', '@sentry/nextjs'],
};
