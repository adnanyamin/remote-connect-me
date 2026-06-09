import Head from 'next/head';
import Link from 'next/link';
import type { GetServerSideProps } from 'next';

const REPO = 'adnanyamin/remote-connect-me';

type Asset = { name: string; browser_download_url: string; size: number };
type Release = { tag_name: string; assets: Asset[] };

type Props = {
  version: string;
  windows: string | null;
  macArm: string | null;
  macX64: string | null;
  linuxAppImage: string | null;
  linuxDeb: string | null;
};

function fmt(bytes: number) {
  return bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(0)} MB` : `${(bytes / 1_000).toFixed(0)} KB`;
}

function DownloadCard({ label, os, url, size, note }: {
  label: string; os: string; url: string | null; size?: number; note?: string;
}) {
  return (
    <div className="card flex items-center justify-between gap-4">
      <div>
        <div className="font-medium">{label}</div>
        <div className="text-sm text-white/50">{os}{size ? ` · ${fmt(size)}` : ''}{note ? ` · ${note}` : ''}</div>
      </div>
      {url ? (
        <a href={url} className="btn-primary whitespace-nowrap" download>↓ Download</a>
      ) : (
        <span className="btn-ghost opacity-40 pointer-events-none">Not available</span>
      )}
    </div>
  );
}

export default function Download({ version, windows, macArm, macX64, linuxAppImage, linuxDeb }: Props) {
  return (
    <>
      <Head>
        <title>Download · RemoteConnectMe</title>
        <meta name="description" content="Download the RemoteConnectMe desktop client for Windows, macOS, and Linux." />
      </Head>
      <div className="min-h-screen">
        <header className="px-6 py-4 flex items-center justify-between max-w-4xl mx-auto">
          <Link href="/" className="font-semibold text-lg">RemoteConnectMe</Link>
          <div className="flex gap-3 text-sm">
            <Link href="/login" className="btn-ghost">Sign in</Link>
            <Link href="/signup" className="btn-primary">Get started</Link>
          </div>
        </header>

        <main className="max-w-2xl mx-auto px-6 py-12 space-y-8">
          <div>
            <h1 className="text-3xl font-bold mb-2">Download</h1>
            <p className="text-white/60">
              Install the RemoteConnectMe client on the PC you want to access remotely.
              After installing, sign in with your account to link the device.
            </p>
            {version && <p className="text-sm text-white/40 mt-2">Latest release: {version}</p>}
          </div>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Windows</h2>
            <DownloadCard
              label="Windows Installer"
              os="Windows 10 / 11"
              url={windows}
              note="64-bit"
            />
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">macOS</h2>
            <DownloadCard label="macOS (Apple Silicon)" os="macOS 12+" url={macArm} note="M1, M2, M3" />
            <DownloadCard label="macOS (Intel)" os="macOS 12+" url={macX64} note="x86-64" />
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Linux</h2>
            <DownloadCard label="AppImage" os="Most distributions" url={linuxAppImage} note="Universal" />
            <DownloadCard label="Debian / Ubuntu (.deb)" os="Debian, Ubuntu, Mint" url={linuxDeb} />
          </section>

          <div className="card text-sm text-white/60 space-y-2">
            <p className="font-medium text-white/80">Getting started</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>Download and install the client on the PC you want to control.</li>
              <li>Open the app — it runs in your system tray.</li>
              <li>Sign in with your RemoteConnectMe account to pair the device.</li>
              <li>From the <Link href="/dashboard" className="text-blue-400 hover:underline">dashboard</Link>, click <b>Connect</b> to start a remote session.</li>
            </ol>
            <p className="pt-1">
              Don&apos;t have an account?{' '}
              <Link href="/signup" className="text-blue-400 hover:underline">Sign up free</Link>
            </p>
          </div>
        </main>
      </div>
    </>
  );
}

export const getServerSideProps: GetServerSideProps<Props> = async () => {
  const empty: Props = {
    version: '', windows: null, macArm: null, macX64: null,
    linuxAppImage: null, linuxDeb: null,
  };

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RemoteConnectMe' },
      // 10s timeout
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { props: { ...empty, windows: `https://github.com/${REPO}/releases/latest/download/RemoteConnectMe-Setup.exe` } };

    const release: Release = await res.json();
    const assets = release.assets || [];

    const find = (pred: (a: Asset) => boolean) => {
      const a = assets.find(pred);
      return a ? { url: a.browser_download_url, size: a.size } : null;
    };

    const win     = find(a => a.name === 'RemoteConnectMe-Setup.exe');
    const macArm  = find(a => a.name.endsWith('.dmg') && a.name.includes('arm64'));
    const macX64  = find(a => a.name.endsWith('.dmg') && (a.name.includes('x64') || !a.name.includes('arm')));
    const appimg  = find(a => a.name.endsWith('.AppImage'));
    const deb     = find(a => a.name.endsWith('.deb'));

    return {
      props: {
        version: release.tag_name || '',
        windows:         win?.url    ?? `https://github.com/${REPO}/releases/latest/download/RemoteConnectMe-Setup.exe`,
        macArm:          macArm?.url  ?? null,
        macX64:          macX64?.url  ?? null,
        linuxAppImage:   appimg?.url  ?? null,
        linuxDeb:        deb?.url     ?? null,
      },
    };
  } catch {
    return {
      props: {
        ...empty,
        windows: `https://github.com/${REPO}/releases/latest/download/RemoteConnectMe-Setup.exe`,
      },
    };
  }
};
