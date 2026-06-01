/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  // Expose at build time which signaling URL the browser should use.
  publicRuntimeConfig: {
    signalingUrl: process.env.NEXT_PUBLIC_SIGNALING_URL || 'ws://localhost:8787',
  },
};
