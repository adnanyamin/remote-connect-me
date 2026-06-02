import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
const SIGNALING_URL = process.env.NEXT_PUBLIC_SIGNALING_URL || 'ws://localhost:8787';

/**
 * Fetches short-lived TURN credentials from /api/turn-credentials.
 *
 * The server mints a per-user, HMAC-signed credential pair valid for 5
 * minutes; we never bake static TURN credentials into the client bundle.
 *
 * Falls back to STUN-only if the endpoint is unavailable — connections
 * behind symmetric NAT will then fail, but most home networks still work.
 */
async function fetchIceServers(): Promise<RTCIceServer[]> {
  try {
    const r = await fetch('/api/turn-credentials', { method: 'POST' });
    if (!r.ok) throw new Error('turn endpoint failed');
    const { iceServers } = await r.json();
    return iceServers as RTCIceServer[];
  } catch {
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

type Status = 'idle' | 'auth' | 'connecting' | 'waiting-host' | 'streaming' | 'error' | 'closed';

interface SourceInfo { id: string; name: string; thumbnail?: string | null; }
interface FileXfer { name: string; size: number; received: number; }

export default function Connect() {
  const router = useRouter();
  const deviceId = router.query.deviceId as string | undefined;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ rtt?: number; res?: string }>({});

  // ----- Session recording -----
  // Policy comes from the connect-token response: 'off' | 'optional' | 'required'.
  const [recordingPolicy, setRecordingPolicy] = useState<'off' | 'optional' | 'required'>('off');
  const [recording, setRecording] = useState(false);
  // For 'optional', the user opts in; for 'required' it's forced on.
  const [recordWanted, setRecordWanted] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recIdRef = useRef<string | null>(null);
  const recSeqRef = useRef(0);
  const recStartRef = useRef(0);
  const recordingPolicyRef = useRef(recordingPolicy);
  recordingPolicyRef.current = recordingPolicy;

  // Multi-monitor
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [activeSource, setActiveSource] = useState<string | null>(null);

  // Files
  const [incomingFile, setIncomingFile] = useState<FileXfer | null>(null);
  const [outgoingFile, setOutgoingFile] = useState<FileXfer | null>(null);

  useEffect(() => {
    if (!deviceId) return;
    let cancelled = false;

    async function start() {
      try {
        setStatus('auth');
        const tokenRes = await fetch(`/api/devices/${deviceId}/connect-token`, { method: 'POST' });
        if (!tokenRes.ok) {
          const e = await tokenRes.json();
          throw new Error(e.error || 'Failed to authorize');
        }
        const tokenData = await tokenRes.json();
        const { token } = tokenData;
        const policy = (tokenData.recordingPolicy as typeof recordingPolicy) || 'off';
        setRecordingPolicy(policy);
        if (policy === 'required') setRecordWanted(true);
        if (cancelled) return;

        setStatus('connecting');
        const ws = new WebSocket(SIGNALING_URL);
        wsRef.current = ws;

        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ type: 'hello', token }));
        });

        ws.addEventListener('message', async (ev) => {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'ready') {
            setStatus('waiting-host');
            const pc = new RTCPeerConnection({ iceServers: await fetchIceServers() });
            pcRef.current = pc;

            pc.addEventListener('icecandidate', (e) => {
              if (e.candidate) ws.send(JSON.stringify({ type: 'signal', payload: { candidate: e.candidate } }));
            });

            pc.addEventListener('track', (e) => {
              if (videoRef.current) {
                videoRef.current.srcObject = e.streams[0];
                setStatus('streaming');
              }
            });

            pc.addEventListener('datachannel', (e) => {
              dcRef.current = e.channel;
              wireDataChannel(e.channel);
            });

            pc.addEventListener('iceconnectionstatechange', () => {
              if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
                setStatus('error');
                setError('Lost connection to host.');
              }
            });

            pc.addTransceiver('video', { direction: 'recvonly' });
          }
          else if (msg.type === 'peer-online') { /* host will send the offer */ }
          else if (msg.type === 'signal' && msg.payload?.sdp) {
            const pc = pcRef.current; if (!pc) return;
            await pc.setRemoteDescription(msg.payload.sdp);
            if (msg.payload.sdp.type === 'offer') {
              const ans = await pc.createAnswer();
              await pc.setLocalDescription(ans);
              ws.send(JSON.stringify({ type: 'signal', payload: { sdp: pc.localDescription } }));
            }
          }
          else if (msg.type === 'signal' && msg.payload?.candidate) {
            try { await pcRef.current?.addIceCandidate(msg.payload.candidate); } catch (e) { console.warn(e); }
          }
          else if (msg.type === 'peer-offline') {
            setStatus('error'); setError('Host went offline.');
          }
          else if (msg.type === 'error') {
            setStatus('error'); setError(msg.message);
          }
        });

        ws.addEventListener('close', () => {
          if (status !== 'streaming') return;
          setStatus('closed');
        });
      } catch (e: any) {
        setStatus('error'); setError(e.message);
      }
    }

    start();
    return () => {
      cancelled = true;
      try { wsRef.current?.send(JSON.stringify({ type: 'bye' })); } catch {}
      wsRef.current?.close();
      pcRef.current?.close();
    };
  }, [deviceId]); // eslint-disable-line

  // ----- Recording control -----
  //
  // Recording captures the *inbound* MediaStream (the decrypted screen we're
  // already displaying) with MediaRecorder. We POST each MediaRecorder blob to
  // the chunk endpoint in order; the server encrypts + stores them, and the
  // download endpoint concatenates the decrypted chunks back into a playable
  // WebM. We use a timeslice so chunks arrive steadily rather than all at the
  // end (so a crashed session still leaves most of the recording on disk).
  function pickMime(): string | null {
    const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const c of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c;
    }
    return null;
  }

  async function startRecording() {
    if (recorderRef.current || !deviceId) return;
    const stream = videoRef.current?.srcObject as MediaStream | null;
    if (!stream) return;
    const mime = pickMime();
    if (!mime) { console.warn('MediaRecorder unsupported in this browser'); return; }

    // Tell the server to open a recording; get the chunk endpoint back.
    let chunkUrl: string;
    try {
      const r = await fetch(`/api/devices/${deviceId}/recordings`, { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'failed to start recording');
      recIdRef.current = data.recordingId;
      chunkUrl = data.chunkUrl;
    } catch (e) {
      console.warn('startRecording:', e);
      return;
    }

    recSeqRef.current = 0;
    recStartRef.current = Date.now();
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    recorder.ondataavailable = async (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      const seq = recSeqRef.current++;
      try {
        await fetch(`${chunkUrl}?seq=${seq}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/octet-stream' },
          body: ev.data,
        });
      } catch (e) {
        // Network blip on one chunk shouldn't kill the whole recording; the
        // gap just shows up as a brief skip on playback.
        console.warn('chunk upload failed', seq, e);
      }
    };
    recorder.start(5000); // emit a blob every 5s
    recorderRef.current = recorder;
    setRecording(true);
  }

  async function stopRecording(aborted = false) {
    const recorder = recorderRef.current;
    const recId = recIdRef.current;
    recorderRef.current = null;
    recIdRef.current = null;
    setRecording(false);
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
      // Give the final ondataavailable a beat to flush before finalizing.
      await new Promise((r) => setTimeout(r, 250));
    }
    if (recId) {
      const durationMs = recStartRef.current ? Date.now() - recStartRef.current : 0;
      try {
        await fetch(`/api/recordings/${recId}/finalize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ durationMs, aborted }),
          keepalive: true, // let it complete even if the page is unloading
        });
      } catch (e) { console.warn('finalize failed', e); }
    }
  }

  // Start/stop recording in response to streaming state + the wanted flag.
  useEffect(() => {
    if (recordingPolicy === 'off') return;
    if (status === 'streaming' && recordWanted && !recorderRef.current) {
      startRecording();
    }
    if ((status !== 'streaming' || !recordWanted) && recorderRef.current) {
      stopRecording(status !== 'streaming');
    }
  }, [status, recordWanted, recordingPolicy]); // eslint-disable-line

  // Stop + finalize on unmount.
  useEffect(() => {
    return () => { if (recorderRef.current) stopRecording(true); };
  }, []); // eslint-disable-line

  // ----- Stats overlay -----
  useEffect(() => {
    if (status !== 'streaming') return;
    const id = setInterval(async () => {
      const pc = pcRef.current; if (!pc) return;
      const report = await pc.getStats();
      let rtt: number | undefined; let res: string | undefined;
      report.forEach((r) => {
        if (r.type === 'candidate-pair' && (r as any).state === 'succeeded' && (r as any).currentRoundTripTime != null) {
          rtt = Math.round((r as any).currentRoundTripTime * 1000);
        }
        if (r.type === 'inbound-rtp' && (r as any).kind === 'video') {
          const w = (r as any).frameWidth, h = (r as any).frameHeight;
          if (w && h) res = `${w}×${h}`;
        }
      });
      setStats({ rtt, res });
    }, 2000);
    return () => clearInterval(id);
  }, [status]);

  // ----- Input forwarding -----
  function send(obj: any) {
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
  }

  function localToRemote(e: React.MouseEvent) {
    const video = videoRef.current; if (!video) return null;
    const rect = video.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x, y, button: e.button };
  }

  function onMouseMove(e: React.MouseEvent) { const c = localToRemote(e); if (c) send({ kind: 'mouse', op: 'move', ...c }); }
  function onMouseDown(e: React.MouseEvent) { const c = localToRemote(e); if (c) send({ kind: 'mouse', op: 'down', ...c }); }
  function onMouseUp(e: React.MouseEvent)   { const c = localToRemote(e); if (c) send({ kind: 'mouse', op: 'up',   ...c }); }
  function onWheel(e: React.WheelEvent)     { send({ kind: 'wheel', dx: e.deltaX, dy: e.deltaY }); }
  function onContextMenu(e: React.MouseEvent) { e.preventDefault(); }

  // ----- Touch input mapping (mobile PWA) -----
  //
  //   1 finger drag         -> mouse move (no buttons)
  //   1 finger tap (<200ms) -> left click at tap position
  //   1 finger long press   -> left button down + drag, up on release
  //   2 finger tap          -> right click at first finger's position
  //   2 finger drag (vert)  -> wheel scroll
  //
  const touchRef = useRef<{
    startedAt: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    longPress: number | null;
    dragging: boolean;
    twoFinger: boolean;
  } | null>(null);

  function touchPoint(t: React.Touch) {
    const video = videoRef.current; if (!video) return null;
    const rect = video.getBoundingClientRect();
    return {
      x: (t.clientX - rect.left) / rect.width,
      y: (t.clientY - rect.top) / rect.height,
    };
  }

  function onTouchStart(e: React.TouchEvent) {
    e.preventDefault();
    const t = e.touches[0]; const p = touchPoint(t); if (!p) return;
    const twoFinger = e.touches.length >= 2;
    if (twoFinger && touchRef.current && touchRef.current.longPress) {
      window.clearTimeout(touchRef.current.longPress);
    }
    touchRef.current = {
      startedAt: Date.now(),
      startX: p.x, startY: p.y, lastX: p.x, lastY: p.y,
      moved: false, longPress: null, dragging: false, twoFinger,
    };
    if (!twoFinger) {
      // Long-press to start a drag: 350ms with no movement.
      const lp = window.setTimeout(() => {
        const r = touchRef.current; if (!r || r.moved) return;
        r.dragging = true;
        send({ kind: 'mouse', op: 'move', x: r.lastX, y: r.lastY, button: 0 });
        send({ kind: 'mouse', op: 'down', x: r.lastX, y: r.lastY, button: 0 });
        // Haptic-ish feedback if available.
        if ('vibrate' in navigator) navigator.vibrate(15);
      }, 350);
      touchRef.current.longPress = lp;
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    e.preventDefault();
    const r = touchRef.current; if (!r) return;
    const p = touchPoint(e.touches[0]); if (!p) return;
    const dx = p.x - r.lastX, dy = p.y - r.lastY;
    r.lastX = p.x; r.lastY = p.y;
    if (Math.hypot(p.x - r.startX, p.y - r.startY) > 0.005) r.moved = true;

    if (e.touches.length >= 2) {
      // Two-finger drag -> wheel scroll. Scale fraction to pixels (~viewport height).
      const vh = window.innerHeight || 600;
      send({ kind: 'wheel', dx: dx * vh, dy: dy * vh });
      return;
    }
    if (r.dragging) {
      // Drag — keep left button held.
      send({ kind: 'mouse', op: 'move', x: p.x, y: p.y, button: 0 });
    } else if (r.moved) {
      // Hover-style move (no button down).
      send({ kind: 'mouse', op: 'move', x: p.x, y: p.y, button: 0 });
    }
  }

  function onTouchEnd(e: React.TouchEvent) {
    e.preventDefault();
    const r = touchRef.current;
    if (!r) return;

    if (r.longPress) { window.clearTimeout(r.longPress); r.longPress = null; }

    const dt = Date.now() - r.startedAt;
    const wasTap = !r.moved && dt < 200;

    if (r.twoFinger && wasTap) {
      // Two-finger tap -> right click.
      send({ kind: 'mouse', op: 'down', x: r.startX, y: r.startY, button: 2 });
      send({ kind: 'mouse', op: 'up',   x: r.startX, y: r.startY, button: 2 });
    } else if (!r.twoFinger && wasTap) {
      // Single tap -> left click.
      send({ kind: 'mouse', op: 'down', x: r.startX, y: r.startY, button: 0 });
      send({ kind: 'mouse', op: 'up',   x: r.startX, y: r.startY, button: 0 });
    } else if (r.dragging) {
      // Release drag.
      send({ kind: 'mouse', op: 'up', x: r.lastX, y: r.lastY, button: 0 });
    }

    if (e.touches.length === 0) touchRef.current = null;
  }

  useEffect(() => {
    function down(e: KeyboardEvent) { if (status === 'streaming') { e.preventDefault(); send({ kind: 'key', op: 'down', code: e.code, key: e.key }); } }
    function up(e: KeyboardEvent)   { if (status === 'streaming') { e.preventDefault(); send({ kind: 'key', op: 'up',   code: e.code, key: e.key }); } }
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [status]);

  // ----- Data channel: file + clipboard + sources -----
  function wireDataChannel(dc: RTCDataChannel) {
    let recvFile: { name: string; size: number; chunks: Uint8Array[]; received: number } | null = null;

    dc.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.kind === 'sources') {
          setSources(msg.items || []);
          setActiveSource(msg.activeId || null);
        } else if (msg.kind === 'file-meta') {
          recvFile = { name: msg.name, size: msg.size, chunks: [], received: 0 };
          setIncomingFile({ name: msg.name, size: msg.size, received: 0 });
        } else if (msg.kind === 'file-eof' && recvFile) {
          const blob = new Blob(recvFile.chunks as BlobPart[]);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = recvFile.name; a.click();
          URL.revokeObjectURL(url);
          recvFile = null;
          setIncomingFile(null);
        } else if (msg.kind === 'file-ack') {
          setOutgoingFile(null);
          console.log('host saved file at', msg.path);
        } else if (msg.kind === 'clipboard.value') {
          // Write the host's clipboard text into ours.
          if (typeof msg.text === 'string') {
            navigator.clipboard.writeText(msg.text).catch(() => {});
          }
        }
      } else if (recvFile) {
        const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(0);
        recvFile.chunks.push(buf);
        recvFile.received += buf.byteLength;
        setIncomingFile((prev) => prev ? { ...prev, received: prev.received + buf.byteLength } : prev);
      }
    });
  }

  // ----- File send (viewer -> host) with progress -----
  async function sendFile(file: File) {
    const dc = dcRef.current; if (!dc || dc.readyState !== 'open') return;
    const CHUNK = 16 * 1024;
    setOutgoingFile({ name: file.name, size: file.size, received: 0 });
    dc.send(JSON.stringify({ kind: 'file-meta', name: file.name, size: file.size }));
    const reader = file.stream().getReader();
    let sent = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      let off = 0;
      while (off < value.byteLength) {
        if (dc.bufferedAmount > 8 * 1024 * 1024) {
          await new Promise((r) => setTimeout(r, 30));
          continue;
        }
        const slice = value.subarray(off, Math.min(off + CHUNK, value.byteLength));
        dc.send(slice);
        off += slice.byteLength;
        sent += slice.byteLength;
        setOutgoingFile((prev) => prev ? { ...prev, received: sent } : prev);
      }
    }
    dc.send(JSON.stringify({ kind: 'file-eof' }));
  }

  // ----- Clipboard sync -----
  async function pushClipboardToHost() {
    try {
      const text = await navigator.clipboard.readText();
      send({ kind: 'clipboard.set', text });
    } catch (e: any) {
      alert('Clipboard read denied: ' + (e?.message || e));
    }
  }
  function pullClipboardFromHost() {
    send({ kind: 'clipboard.get' });
  }

  // ----- Multi-monitor pick -----
  function pickSource(id: string) {
    setActiveSource(id);
    send({ kind: 'select-source', sourceId: id });
  }

  const xferPct = (x: FileXfer | null) =>
    x && x.size ? Math.round((x.received / x.size) * 100) : 0;

  return (
    <>
      <Head><title>Connecting · RemoteConnectMe</title></Head>
      <div className="min-h-screen flex flex-col bg-black text-white">
        <header className="px-4 py-2 bg-black/40 flex flex-wrap items-center gap-3 text-sm">
          <button className="px-2 py-1 rounded hover:bg-white/10" onClick={() => router.push('/dashboard')}>← Back</button>

          <span className="text-white/60">Status: <b>{status}</b></span>
          {stats.rtt != null && <span className="text-white/60">RTT: {stats.rtt}ms</span>}
          {stats.res && <span className="text-white/60">{stats.res}</span>}
          {error && <span className="text-red-300">{error}</span>}

          {/* Recording indicator / control */}
          {recordingPolicy === 'required' && (
            <span className="flex items-center gap-1 text-red-300" title="This session is being recorded (required by your organization).">
              <span className={`inline-block w-2 h-2 rounded-full bg-red-500 ${recording ? 'animate-pulse' : ''}`} />
              REC
            </span>
          )}
          {recordingPolicy === 'optional' && (
            <label className="flex items-center gap-1 cursor-pointer" title="Record this session.">
              <input
                type="checkbox"
                className="accent-red-500"
                checked={recordWanted}
                onChange={(e) => setRecordWanted(e.target.checked)}
              />
              <span className={recording ? 'text-red-300' : 'text-white/60'}>
                {recording ? '● Recording' : 'Record'}
              </span>
            </label>
          )}

          {sources.length > 1 && (
            <label className="flex items-center gap-2 ml-auto">
              <span className="text-white/60">Monitor</span>
              <select
                className="bg-white/10 rounded px-2 py-1"
                value={activeSource || ''}
                onChange={(e) => pickSource(e.target.value)}
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          )}

          <div className="flex items-center gap-2">
            <button className="px-2 py-1 rounded hover:bg-white/10" onClick={pushClipboardToHost} title="Send local clipboard to host">
              Send clipboard
            </button>
            <button className="px-2 py-1 rounded hover:bg-white/10" onClick={pullClipboardFromHost} title="Receive host clipboard">
              Receive clipboard
            </button>
            <label className="px-2 py-1 rounded hover:bg-white/10 cursor-pointer">
              Send file
              <input
                type="file"
                hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) sendFile(f); e.currentTarget.value = ''; }}
              />
            </label>
          </div>
        </header>

        {(incomingFile || outgoingFile) && (
          <div className="px-4 py-1 text-xs bg-black/30 text-white/70 flex gap-4">
            {outgoingFile && (
              <span>↑ Sending {outgoingFile.name}: {xferPct(outgoingFile)}%</span>
            )}
            {incomingFile && (
              <span>↓ Receiving {incomingFile.name}: {xferPct(incomingFile)}%</span>
            )}
          </div>
        )}

        <div className="flex-1 grid place-items-center">
          {status === 'streaming' ? (
            <video
              ref={videoRef}
              autoPlay playsInline muted
              className="max-h-full max-w-full outline-none cursor-crosshair touch-none select-none"
              tabIndex={0}
              onMouseMove={onMouseMove}
              onMouseDown={onMouseDown}
              onMouseUp={onMouseUp}
              onWheel={onWheel}
              onContextMenu={onContextMenu}
              onTouchStart={onTouchStart}
              onTouchMove={onTouchMove}
              onTouchEnd={onTouchEnd}
              onTouchCancel={onTouchEnd}
            />
          ) : status === 'error' ? (
            <div className="text-red-300 max-w-md text-center p-6">
              <p className="font-semibold mb-2">Couldn't connect</p>
              <p className="text-sm">{error}</p>
            </div>
          ) : (
            <div className="text-white/60 text-center p-6">
              <p>{status === 'auth' && 'Authorizing…'}
                 {status === 'connecting' && 'Connecting to signaling…'}
                 {status === 'waiting-host' && 'Waiting for host to accept…'}
                 {status === 'closed' && 'Disconnected.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
