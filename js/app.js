/* App entry: load screen, screen router, waveform extraction, shortcuts. */
(function (global) {
  'use strict';

  const $ = (s) => document.querySelector(s);

  let videoFile = null;
  let videoRaw = null;
  let srtFile = null;
  let srtRaw = null;
  let sync = null;
  let renderer = null;
  let extractionCancelled = false;
  let session = 0;

  function toast(msg, type) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'show' + (type ? ' ' + type : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = ''; }, 3200);
  }
  global.toast = toast;

  function setWaveStatus(text, mode) {
    const chip = $('#wave-status');
    chip.className = 'status-chip' + (mode ? ' ' + mode : '');
    $('#wave-status-text').textContent = text;
  }

  function setupDropZone(zoneId, inputId, filenameId, onLoad) {
    const zone = $(zoneId);
    const input = $(inputId);
    const lbl = $(filenameId);
    input.addEventListener('change', () => {
      if (input.files.length > 0) {
        const f = input.files[0];
        lbl.textContent = f.name;
        zone.classList.add('loaded');
        onLoad(f, input);
      }
    });
    zone.addEventListener('click', () => input.click());
    zone.querySelectorAll('select').forEach((sel) => {
      sel.addEventListener('click', (e) => e.stopPropagation());
    });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const f = e.dataTransfer.files[0];
      if (!f) return;
      lbl.textContent = f.name;
      zone.classList.add('loaded');
      input.files = e.dataTransfer.files;
      onLoad(f, input);
    });
  }

  function onEncodingChange() {
    if (!srtRaw) return;
    const enc = $('#encoding-select').value;
    const text = new TextDecoder(enc).decode(srtRaw);
    const format = global.SubtitleFormats.detect(srtFile.name, text);
    if (sync) {
      const r = sync.loadSubtitle(srtFile.name, srtRaw, enc, format);
      updateSubInfo(format, r);
    }
  }

  function updateSubInfo(format, r) {
    $('#info-format').textContent = format.toUpperCase();
    if (r && r.skipped > 0) toast(r.skipped + ' satır atlandı (bozuk).', 'error');
  }

  function startSync() {
    if (!videoFile || !srtFile) return;
    session++;
    const mySession = session;
    $('#load-screen').classList.remove('active');
    $('#sync-screen').classList.add('active');

    $('#info-video').textContent = videoFile.name;
    $('#info-srt').textContent = srtFile.name;

    const enc = $('#encoding-select').value;
    const text = new TextDecoder(enc).decode(srtRaw);
    const format = global.SubtitleFormats.detect(srtFile.name, text);
    const r = sync.loadSubtitle(srtFile.name, srtRaw, enc, format);
    updateSubInfo(format, r);

    global.Player.load(videoFile).then(() => {
      if (mySession !== session) return;
      renderer.resize();
      extractWaveform();
    }).catch((e) => {
      if (mySession !== session) return;
      console.error('Video load:', e);
      goBack();
      toast((e && e.message ? e.message : 'Video yüklenemedi') + ' — başka bir dosya deneyin.', 'error');
    });
  }

  function extractWaveform() {
    extractionCancelled = false;
    setWaveStatus('Ses dalgası çözümleniyor...', 'working');
    const loading = $('#timeline-loading');
    const fill = $('#timeline-bar-fill');
    const text = $('#timeline-loading-text');
    loading.hidden = false;
    fill.style.width = '0%';
    text.textContent = 'Ses dalgası çözümleniyor...';

    global.WaveformEngine.extract(videoFile, global.Player.video, {
      onProgress: (p) => {
        fill.style.width = Math.round(p * 100) + '%';
        text.textContent = 'Ses dalgası çözümleniyor... %' + Math.round(p * 100);
      },
      onStatus: (s) => {
        if (s === 'capturing') text.textContent = 'Videoyu oynatarak ses yakalanıyor (yavaş mod)...';
      },
      isCancelled: () => extractionCancelled
    }).then((data) => {
      renderer.setData(data);
      loading.hidden = true;
      setWaveStatus('Ses dalgası hazır', 'ok');
    }).catch((e) => {
      loading.hidden = true;
      if (e && e.message === 'cancelled') {
        setWaveStatus('Ses dalgası iptal edildi', 'error');
      } else {
        console.error('Waveform:', e);
        setWaveStatus('Ses dalgası alınamadı — hizalama yine de çalışır', 'error');
        toast('Ses dalgası çözümlenemedi (' + (e && e.message ? e.message : e) + ')', 'error');
      }
    });
  }

  function goBack() {
    session++;
    extractionCancelled = true;
    global.Player.cleanup();
    sync.clear();
    renderer.resetView();
    renderer.setData({ peaks: null, duration: 0, sampleInterval: 0.1 });
    $('#sync-screen').classList.remove('active');
    $('#load-screen').classList.add('active');
    setWaveStatus('Ses dalgası bekleniyor', '');
  }

  function wireSyncPanel() {
    $('#capture-btn').addEventListener('click', () => sync.captureTime());
    $('#manual-align-btn').addEventListener('click', () => sync.manualAlign());
    $('#ft-1000m').addEventListener('click', () => sync.fineTune(-1000));
    $('#ft-100m').addEventListener('click', () => sync.fineTune(-100));
    $('#ft-plus-100m').addEventListener('click', () => sync.fineTune(100));
    $('#ft-plus-1000m').addEventListener('click', () => sync.fineTune(1000));
    $('#reset-offset').addEventListener('click', () => sync.resetOffset());
    $('#save-btn').addEventListener('click', () => sync.download());
    $('#back-btn').addEventListener('click', goBack);
  }

  function init() {
    global.Player.init();
    renderer = global.WaveformEngine.createRenderer($('#waveform'));
    sync = global.Sync(renderer);
    sync.initTimeline();
    wireSyncPanel();

    setupDropZone('video-zone', 'video-input', 'video-filename', (f) => {
      videoFile = f;
      const reader = new FileReader();
      reader.onload = () => { videoRaw = reader.result; };
      reader.readAsArrayBuffer(f);
      updateGoButton();
    });

    setupDropZone('srt-zone', 'srt-input', 'srt-filename', (f) => {
      srtFile = f;
      const reader = new FileReader();
      reader.onload = () => {
        srtRaw = new Uint8Array(reader.result);
        onEncodingChange();
        updateGoButton();
      };
      reader.readAsArrayBuffer(f);
    });

    $('#encoding-select').addEventListener('change', onEncodingChange);
    $('#go-sync').addEventListener('click', startSync);

    global.Player.onTime((t) => {
      if (renderer) renderer.setCurrentTime(t);
      if (sync) sync.updateActiveSubtitle(t);
    });
    global.Player.onMeta(() => {
      if (renderer) renderer.resize();
    });

    window.addEventListener('resize', () => { if (renderer) renderer.resize(); });

    document.addEventListener('keydown', (e) => {
      if (!$('#sync-screen').classList.contains('active')) return;
      if (e.target.tagName === 'INPUT') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      switch (e.key) {
        case ' ': e.preventDefault(); global.Player.togglePlay(); break;
        case 'ArrowLeft': global.Player.skip(-1); break;
        case 'ArrowRight': global.Player.skip(1); break;
        case 'ArrowUp': global.Player.skip(5); break;
        case 'ArrowDown': global.Player.skip(-5); break;
        case 'c': case 'C': sync.captureTime(); break;
      }
    });
  }

  function updateGoButton() {
    $('#go-sync').disabled = !(videoFile && srtFile);
  }

  document.addEventListener('DOMContentLoaded', init);
})(typeof globalThis !== 'undefined' ? globalThis : this);
