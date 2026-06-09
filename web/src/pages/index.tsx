import Link from 'next/link';
import Head from 'next/head';

export default function Landing() {
  return (
    <>
      <Head><title>RemoteConnectMe — remote desktop</title></Head>
      <div className="min-h-screen flex flex-col">
        <header className="px-6 py-4 flex items-center justify-between max-w-6xl mx-auto w-full">
          <div className="font-semibold text-lg">RemoteConnectMe</div>
          <nav className="flex gap-3 text-sm">
            <Link href="/login" className="btn-ghost">Sign in</Link>
            <Link href="/signup" className="btn-primary">Get started</Link>
          </nav>
        </header>

        <main className="flex-1 flex items-center justify-center px-6">
          <div className="max-w-3xl text-center py-20">
            <h1 className="text-5xl sm:text-6xl font-semibold tracking-tight">
              Your computer, from anywhere.
            </h1>
            <p className="mt-6 text-lg text-white/70">
              Open-source, end-to-end encrypted remote desktop. Install the
              client, sign in, click connect.
            </p>
            <div className="mt-8 flex justify-center gap-3">
              <Link href="/signup" className="btn-primary">Create a free account</Link>
              <a href="#how" className="btn-ghost">How it works</a>
            </div>
          </div>
        </main>

        <section id="how" className="max-w-5xl mx-auto px-6 py-16 grid sm:grid-cols-3 gap-6">
          <Link href="/download" className="card hover:border-white/20 transition-colors">
            <div className="font-semibold mb-2">1. Install</div>
            <div className="text-white/70 text-sm">Download the client and pair it to your account in 30 seconds.</div>
            <div className="text-blue-400 text-xs mt-2">Download →</div>
          </Link>
          <div className="card">
            <div className="font-semibold mb-2">2. Connect</div>
            <div className="text-white/70 text-sm">Open any browser, hit Connect on your device. WebRTC handles the rest, peer-to-peer.</div>
          </div>
          <div className="card">
            <div className="font-semibold mb-2">3. Control</div>
            <div className="text-white/70 text-sm">See the screen, type, click, transfer files. Encrypted end-to-end.</div>
          </div>
        </section>

        <footer className="px-6 py-8 text-center text-white/40 text-sm">
          Open source · MIT-licensed · <a href="https://github.com/">Source</a>
        </footer>
      </div>
    </>
  );
}
