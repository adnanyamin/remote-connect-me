import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        {/* PWA */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#0b1020" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="RemoteConnectMe" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
        {/* Mobile viewport — disable user pinch-zoom so we can capture pinch
            gestures and forward them as scroll/zoom over the data channel. */}
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
