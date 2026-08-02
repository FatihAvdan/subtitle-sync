/* Waveform extraction engine (3-tier) + canvas timeline renderer. */
(function (global) {
  'use strict';

  const SAMPLE_INTERVAL = 0.1;

  function computePeaks(channelData, sampleRate, duration) {
    const windowSamples = Math.floor(sampleRate * SAMPLE_INTERVAL);
    const numPeaks = Math.ceil(channelData.length / windowSamples);
    const peaks = new Float32Array(numPeaks);
    const stride = Math.max(1, Math.floor(windowSamples / 100));
    for (let i = 0; i < numPeaks; i++) {
      let max = 0;
      const start = i * windowSamples;
      const end = Math.min(start + windowSamples, channelData.length);
      for (let j = start; j < end; j += stride) {
        const v = channelData[j];
        if (v > max) max = v;
        else if (-v > max) max = -v;
      }
      peaks[i] = Math.min(max * 1.4, 1);
    }
    return { peaks, duration, sampleInterval: SAMPLE_INTERVAL };
  }

  function PeakAccumulator(sampleRate) {
    const windowCount = Math.floor(sampleRate * SAMPLE_INTERVAL);
    let curMax = 0;
    let curCount = 0;
    const peaks = [];
    this.push = function (ch0) {
      for (let i = 0; i < ch0.length; i++) {
        const v = ch0[i];
        if (v > curMax) curMax = v;
        else if (-v > curMax) curMax = -v;
        curCount++;
        if (curCount >= windowCount) {
          peaks.push(Math.min(curMax * 1.4, 1));
          curMax = 0;
          curCount = 0;
        }
      }
    };
    this.result = function (duration) {
      return { peaks: Float32Array.from(peaks), duration, sampleInterval: SAMPLE_INTERVAL };
    };
  }

  async function tier1DecodeAudioData(file, ctx) {
    const buffer = await file.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(buffer);
    return computePeaks(audioBuf.getChannelData(0), audioBuf.sampleRate, audioBuf.duration);
  }

  function tier2Mp4box(file, onProgress, isCancelled) {
    const MP4Box = global.MP4Box;
    if (!MP4Box || typeof global.AudioDecoder === 'undefined') {
      return Promise.reject(new Error('WebCodecs veya mp4box yok'));
    }
    return file.arrayBuffer().then((buffer) => {
      const mp4 = MP4Box.createFile();
      return new Promise((resolve, reject) => {
        mp4.onReady = (info) => {
          const t = info.audioTracks && info.audioTracks[0];
          if (t) resolve(t); else reject(new Error('Video içinde ses izi bulunamadı'));
        };
        mp4.onError = (e) => reject(new Error(String(e)));
        try {
          buffer.fileStart = 0;
          mp4.appendBuffer(buffer);
          mp4.flush();
        } catch (e) { reject(e); }
      }).then((track) => runDecoder(mp4, track, onProgress, isCancelled));
    });
  }

  function runDecoder(mp4, track, onProgress, isCancelled) {
    const samplesTotal = track.nb_samples || 0;
    const durationSec = track.duration / track.timescale;
    let description;
    try {
      const trak = mp4.getTrackById(track.id);
      const stsd = trak.mdia.minf.stbl.stsd.entries[0];
      if (stsd.esds) {
        const dsi = (stsd.esds.boxes || []).find((b) => b.type === 'decSpecificInfo');
        if (dsi && dsi.esds) description = dsi.esds;
      }
    } catch (e) { description = undefined; }

    return new Promise((resolve, reject) => {
      const acc = new PeakAccumulator(track.samplerate);
      let gotSamples = 0;
      let cancelled = false;
      let decoder = null;
      let finished = false;

      const finish = (err, result) => {
        if (finished) return;
        finished = true;
        try { mp4.stop(); } catch (e) {}
        try { if (decoder) decoder.close(); } catch (e) {}
        if (err) reject(err); else resolve(result);
      };

      try {
        decoder = new global.AudioDecoder({
          output: (frame) => {
            const n = frame.numberOfFrames;
            if (n > 0) {
              const buf = new Float32Array(n * frame.numberOfChannels);
              frame.copyTo(buf);
              acc.push(buf.subarray(0, n));
            }
            frame.close();
          },
          error: (e) => { if (!cancelled) finish(new Error('AudioDecoder: ' + (e.message || e)), null); }
        });
        decoder.configure({
          codec: track.codec || 'mp4a.40.2',
          sampleRate: track.samplerate,
          numberOfChannels: track.channel_count || 2,
          description: description ? new Uint8Array(description) : undefined
        });
      } catch (e) {
        return finish(e, null);
      }

      decoder.addEventListener('dequeue', () => {
        if (gotSamples >= samplesTotal && decoder.decodeQueueSize === 0) {
          decoder.flush().then(
            () => finish(null, acc.result(durationSec)),
            (e) => finish(e, null)
          );
        }
      });

      mp4.setExtractionOptions(track.id, null, { nbSamples: 500 });
      mp4.onSamples = (id, user, samples) => {
        for (const s of samples) {
          if (isCancelled()) { cancelled = true; mp4.stop(); finish(new Error('cancelled'), null); return; }
          gotSamples++;
          decoder.decode(new global.EncodedAudioChunk({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: Math.round(s.cts * 1e6 / track.timescale),
            duration: Math.round(s.duration * 1e6 / track.timescale),
            data: s.data
          }));
        }
        onProgress(Math.min(1, gotSamples / (samplesTotal || 1)));
        if (decoder.decodeQueueSize > 20) mp4.stop();
        else if (gotSamples < samplesTotal) mp4.start();
      };
      mp4.start();
    });
  }

  function tier3CaptureStream(videoEl, ctx, onProgress, isCancelled) {
    if (typeof videoEl.captureStream !== 'function') {
      return Promise.reject(new Error('captureStream desteklenmiyor'));
    }
    const wasPaused = videoEl.paused;
    const wasVolume = videoEl.volume;
    const wasTime = videoEl.currentTime;
    return new Promise((resolve, reject) => {
      let settled = false;
      let src = null;
      let proc = null;
      let ticker = null;
      const cleanup = (err, result) => {
        if (settled) return;
        settled = true;
        if (ticker) clearInterval(ticker);
        videoEl.removeEventListener('ended', onEnded);
        videoEl.removeEventListener('error', onError);
        try { if (src) src.disconnect(); } catch (e) {}
        try { if (proc) proc.disconnect(); } catch (e) {}
        try { if (proc) proc.onaudioprocess = null; } catch (e) {}
        if (wasPaused) videoEl.pause();
        videoEl.volume = wasVolume;
        videoEl.currentTime = wasTime;
        if (err) reject(err); else resolve(result);
      };
      const onEnded = () => cleanup(null, acc.result(videoEl.duration));
      const onError = () => cleanup(new Error('Video oynatılamadı'), null);

      videoEl.volume = 0;
      videoEl.currentTime = 0;
      const acc = new PeakAccumulator(ctx.sampleRate);

      videoEl.play().then(() => {
        let stream;
        try { stream = videoEl.captureStream(); } catch (e) { return cleanup(e, null); }
        const audioTrack = stream.getAudioTracks()[0];
        if (!audioTrack) return cleanup(new Error('Video içinde ses izi bulunamadı'), null);
        src = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
        proc = ctx.createScriptProcessor(4096, 1, 1);
        src.connect(proc);
        proc.connect(ctx.destination);
        proc.onaudioprocess = (e) => {
          acc.push(e.inputBuffer.getChannelData(0));
          onProgress(Math.min(1, videoEl.currentTime / (videoEl.duration || 1)));
        };
        videoEl.addEventListener('ended', onEnded);
        videoEl.addEventListener('error', onError);
        ticker = setInterval(() => {
          if (isCancelled()) cleanup(new Error('cancelled'), null);
        }, 250);
      }, () => cleanup(new Error('Video oynatılamadı'), null));
    });
  }

  async function extract(file, videoEl, opts) {
    const onProgress = (opts && opts.onProgress) || function () {};
    const onStatus = (opts && opts.onStatus) || function () {};
    const isCancelled = (opts && opts.isCancelled) || function () { return false; };
    let ctx = null;
    if (typeof global.AudioContext !== 'undefined') ctx = new global.AudioContext();

    if (ctx) {
      try {
        onStatus('decoding');
        return await tier1DecodeAudioData(file, ctx);
      } catch (e) { /* fall through */ }
    }

    const ext = (file.name || '').split('.').pop().toLowerCase();
    if (['mp4', 'mov', 'm4v', 'm4a', '3gp'].indexOf(ext) >= 0) {
      try {
        onStatus('decoding');
        return await tier2Mp4box(file, onProgress, isCancelled);
      } catch (e) {
        if (isCancelled()) throw new Error('cancelled');
        /* fall through to tier 3 */
      }
    }

    if (!ctx) throw new Error('Tarayıcınız ses çözümlemesini desteklemiyor');
    onStatus('capturing');
    return await tier3CaptureStream(videoEl, ctx, onProgress, isCancelled);
  }

  // ── Renderer ──

  function createRenderer(canvas) {
    const ctx2d = canvas.getContext('2d');
    const WINDOW_HALF = 10;
    let peaks = null;
    let duration = 0;
    let sampleInterval = SAMPLE_INTERVAL;
    let entries = [];
    let selectedIdx = -1;
    let offsetMs = 0;
    let currentTime = 0;
    let viewCenter = -1;
    let dpr = 1;

    function windowBounds() {
      const center = viewCenter >= 0 ? viewCenter : currentTime;
      const tStart = Math.max(0, center - WINDOW_HALF);
      const tEnd = Math.min(duration > 0 ? duration : center + WINDOW_HALF, center + WINDOW_HALF);
      if (duration > 0 && tStart >= tEnd) return { tStart: 0, tEnd: duration };
      return { tStart, tEnd };
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      redraw();
    }

    function redraw() {
      const W = canvas.width;
      const H = canvas.height;
      if (!W || !H) return;
      ctx2d.clearRect(0, 0, W, H);
      const { tStart, tEnd } = windowBounds();
      const span = (tEnd - tStart) || 1;
      const xOf = (t) => ((t - tStart) / span) * W;
      const halfH = H / 2;

      // time ruler + grid
      ctx2d.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx2d.lineWidth = 1;
      ctx2d.fillStyle = '#8a93a6';
      ctx2d.font = '10px monospace';
      ctx2d.textAlign = 'center';
      const step = 1;
      const first = Math.ceil(tStart / step) * step;
      for (let t = first; t <= tEnd; t += step) {
        const x = Math.round(xOf(t)) + 0.5;
        const major = Math.round(t) % 5 === 0;
        ctx2d.beginPath();
        ctx2d.moveTo(x, major ? H - 22 : H - 12);
        ctx2d.lineTo(x, H);
        ctx2d.stroke();
        if (major) {
          ctx2d.fillText(Math.floor(t / 60) + ':' + String(Math.round(t % 60)).padStart(2, '0'), x, H - 8);
        }
      }

      // SRT blocks
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const s = (e.origStartMs + offsetMs) / 1000;
        const ed = (e.origEndMs + offsetMs) / 1000;
        if (ed < tStart || s > tEnd) continue;
        const x1 = xOf(s);
        const x2 = Math.max(xOf(ed), x1 + 2);
        const active = currentTime * 1000 >= s * 1000 && currentTime * 1000 <= ed * 1000;
        ctx2d.fillStyle = active
          ? 'rgba(52, 211, 153, 0.4)'
          : (i === selectedIdx ? 'rgba(56, 189, 248, 0.4)' : 'rgba(56, 189, 248, 0.16)');
        ctx2d.fillRect(x1, 0, x2 - x1, H - 22);
      }

      // waveform
      if (peaks) {
        ctx2d.strokeStyle = '#38bdf8';
        ctx2d.lineWidth = Math.max(1, dpr * 0.8);
        ctx2d.beginPath();
        for (let i = 0; i < peaks.length; i++) {
          const t = i * sampleInterval;
          if (t < tStart) continue;
          if (t > tEnd) break;
          const x = xOf(t);
          const p = peaks[i];
          ctx2d.moveTo(x, halfH - p * halfH * 0.85);
          ctx2d.lineTo(x, halfH + p * halfH * 0.85);
        }
        ctx2d.stroke();
      }

      // playhead
      const cx = Math.round(xOf(currentTime)) + 0.5;
      ctx2d.strokeStyle = '#f87171';
      ctx2d.lineWidth = Math.max(1, dpr * 1.5);
      ctx2d.beginPath();
      ctx2d.moveTo(cx, 0);
      ctx2d.lineTo(cx, H - 22);
      ctx2d.stroke();
      ctx2d.fillStyle = '#f87171';
      ctx2d.beginPath();
      ctx2d.arc(cx, halfH, 4 * dpr, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.fillStyle = '#f87171';
      ctx2d.fillText('▶', cx, 16 * dpr);
    }

    function timeAtX(clientX) {
      const rect = canvas.getBoundingClientRect();
      const x = rect.width ? (clientX - rect.left) / rect.width : 0;
      const { tStart, tEnd } = windowBounds();
      return tStart + x * (tEnd - tStart);
    }

    function blockAtX(clientX) {
      const t = timeAtX(clientX) * 1000;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const s = e.origStartMs + offsetMs;
        const ed = e.origEndMs + offsetMs;
        if (t >= s && t < ed) return i;
      }
      return -1;
    }

    return {
      resize,
      redraw,
      setData(p) { peaks = p.peaks; duration = p.duration; sampleInterval = p.sampleInterval; redraw(); },
      setEntries(list) { entries = list; redraw(); },
      setSelected(idx) { selectedIdx = idx; redraw(); },
      setOffset(ms) { offsetMs = ms; redraw(); },
      setCurrentTime(t) { currentTime = t; redraw(); },
      setViewCenter(t) { viewCenter = t; redraw(); },
      resetView() { viewCenter = -1; redraw(); },
      timeAtX,
      blockAtX,
      get duration() { return duration; },
      get offsetMs() { return offsetMs; }
    };
  }

  const WaveformEngine = { SAMPLE_INTERVAL, extract, computePeaks, createRenderer };

  if (typeof module !== 'undefined' && module.exports) module.exports = WaveformEngine;
  else global.WaveformEngine = WaveformEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
