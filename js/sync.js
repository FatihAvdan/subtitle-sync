/* Subtitle state, list rendering, sync panel actions, timeline drag-to-align. */
(function (global) {
  'use strict';

  function createSync(renderer) {
    const state = {
      entries: [],
      offsetMs: 0,
      selectedIdx: -1,
      format: 'srt',
      assHeader: null,
      assFields: null,
      subName: 'subtitle'
    };

    const $ = (s) => document.querySelector(s);
    const el = {
      list: $('#sub-list'),
      count: $('#sub-count'),
      selectedInfo: $('#selected-info'),
      offsetDisplay: $('#offset-display'),
      manualTime: $('#manual-time'),
      overlay: $('#sub-overlay'),
      canvas: $('#waveform')
    };

    function applyOffset() {
      for (const e of state.entries) {
        e.startMs = e.origStartMs + state.offsetMs;
        e.endMs = e.origEndMs + state.offsetMs;
      }
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function fmt(ms) { return global.SubtitleFormats.msToTimestamp(ms); }

    function loadSubtitle(name, text, encoding, format) {
      const decoded = new TextDecoder(encoding).decode(text);
      state.format = format;
      state.subName = name;
      state.offsetMs = 0;
      state.selectedIdx = -1;
      let skipped = 0;
      if (format === 'ass') {
        const r = global.SubtitleFormats.parseASS(decoded);
        state.entries = r.entries;
        state.assHeader = r.header;
        state.assFields = r.fields;
        skipped = countSkipped(decoded, r.entries.length);
      } else {
        const parsed = global.SubtitleFormats.parse(decoded, format);
        const valid = parsed.length;
        state.entries = parsed;
        state.assHeader = null;
        state.assFields = null;
        skipped = countSkipped(decoded, valid);
      }
      applyOffset();
      renderer.setEntries(state.entries);
      renderer.setSelected(-1);
      renderList();
      updateViews();
      return { count: state.entries.length, skipped };
    }

    function countSkipped(text, parsedCount) {
      const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/).filter((b) => b.trim() !== '');
      return Math.max(0, blocks.length - parsedCount);
    }

    function renderList() {
      if (state.entries.length === 0) {
        el.list.innerHTML = '<div class="empty-state">Altyazı yüklenmedi veya içeriği boş</div>';
        el.count.textContent = '';
        return;
      }
      el.count.textContent = state.entries.length + ' satır';
      let html = '';
      for (let i = 0; i < state.entries.length; i++) {
        const e = state.entries[i];
        const sel = i === state.selectedIdx ? ' selected' : '';
        html += '<div class="sub-entry' + sel + '" data-idx="' + i + '">' +
          '<div class="sub-time"><span class="sub-index">#' + e.index + '</span>' +
          fmt(e.startMs) + ' → ' + fmt(e.endMs) + '</div>' +
          '<div class="sub-text">' + escapeHtml(e.text) + '</div></div>';
      }
      el.list.innerHTML = html;
      el.list.querySelectorAll('.sub-entry').forEach((node) => {
        node.addEventListener('click', () => selectEntry(parseInt(node.getAttribute('data-idx'), 10)));
      });
    }

    function findActiveIndex(currentMs) {
      let lo = 0, hi = state.entries.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const e = state.entries[mid];
        if (currentMs < e.startMs) hi = mid - 1;
        else if (currentMs > e.endMs) lo = mid + 1;
        else return mid;
      }
      return -1;
    }

    let lastActiveIdx = -1;

    function updateActiveSubtitle(currentTimeSec) {
      const currentMs = currentTimeSec * 1000;
      const found = findActiveIndex(currentMs);
      if (found >= 0) {
        el.overlay.textContent = state.entries[found].text;
        el.overlay.hidden = false;
      } else {
        el.overlay.hidden = true;
      }
      const nodes = el.list.querySelectorAll('.sub-entry');
      for (const node of nodes) node.classList.remove('active-playing');
      if (found >= 0 && el.list.children[found]) {
        const child = el.list.children[found];
        child.classList.add('active-playing');
        if (found !== lastActiveIdx) {
          child.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          lastActiveIdx = found;
        }
      } else {
        lastActiveIdx = -1;
      }
    }

    function updateViews() {
      updateSelectedInfo();
      updateOffsetDisplay();
    }

    function updateSelectedInfo() {
      if (state.selectedIdx < 0 || state.selectedIdx >= state.entries.length) {
        el.selectedInfo.textContent = '—';
        return;
      }
      const e = state.entries[state.selectedIdx];
      el.selectedInfo.textContent = '#' + e.index + ': ' + fmt(e.startMs) + ' → ' + fmt(e.endMs) +
        ' — "' + e.text.substring(0, 60) + (e.text.length > 60 ? '...' : '') + '"';
    }

    function updateOffsetDisplay() {
      const sign = state.offsetMs >= 0 ? '+' : '';
      el.offsetDisplay.textContent = sign + (state.offsetMs / 1000).toFixed(3) + ' sn';
    }

    function flashOffset() {
      el.offsetDisplay.classList.remove('flash');
      void el.offsetDisplay.offsetWidth;
      el.offsetDisplay.classList.add('flash');
      setTimeout(() => el.offsetDisplay.classList.remove('flash'), 400);
    }

    function selectEntry(idx) {
      state.selectedIdx = idx;
      renderer.setSelected(idx);
      renderList();
      updateViews();
      const child = el.list.children[idx];
      if (child) child.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function captureTime() {
      if (state.selectedIdx < 0) { toast('Önce altyazı listesinden bir replik seçin.', 'error'); return; }
      const videoTimeMs = global.Player.currentTime * 1000;
      state.offsetMs = Math.round(videoTimeMs - state.entries[state.selectedIdx].origStartMs);
      commitOffset();
    }

    function manualAlign() {
      if (state.selectedIdx < 0) { toast('Önce altyazı listesinden bir replik seçin.', 'error'); return; }
      const raw = el.manualTime.value.trim();
      if (!raw) { toast('Lütfen bir zaman değeri girin.', 'error'); return; }
      const ms = global.SubtitleFormats.timestampToMs(raw);
      if (ms >= 0) {
        state.offsetMs = Math.round(ms - state.entries[state.selectedIdx].origStartMs);
      } else {
        const m2 = /(\d{1,2}):(\d{2}):(\d{2})/.exec(raw);
        if (m2) {
          const h2 = parseInt(m2[1], 10), min2 = parseInt(m2[2], 10), s2 = parseInt(m2[3], 10);
          state.offsetMs = Math.round((h2 * 3600000 + min2 * 60000 + s2 * 1000) - state.entries[state.selectedIdx].origStartMs);
        } else {
          toast('Geçersiz zaman formatı. Örnek: 00:01:23,456 veya 00:01:23', 'error');
          return;
        }
      }
      el.manualTime.value = '';
      commitOffset();
    }

    function fineTune(deltaMs) {
      state.offsetMs += deltaMs;
      commitOffset();
    }

    function resetOffset() {
      state.offsetMs = 0;
      commitOffset();
    }

    function commitOffset() {
      applyOffset();
      renderer.setOffset(state.offsetMs);
      renderList();
      updateViews();
      flashOffset();
    }

    function download() {
      if (state.entries.length === 0) return;
      applyOffset();
      const out = global.SubtitleFormats.serialize(state.entries, state.format, state.assHeader, state.assFields);
      const ext = state.format === 'ass' ? 'ass' : state.format === 'vtt' ? 'vtt' : 'srt';
      const base = state.subName.replace(/\.(srt|vtt|ass|ssa|txt)$/i, '');
      const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
      const textBytes = new TextEncoder().encode(out);
      const merged = new Uint8Array(bom.length + textBytes.length);
      merged.set(bom);
      merged.set(textBytes, bom.length);
      const blob = new Blob([merged], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = base + '_sync.' + ext;
      a.click();
      URL.revokeObjectURL(url);
      toast('Altyazı indirildi: ' + a.download, 'success');
    }

    function clear() {
      state.entries = [];
      state.offsetMs = 0;
      state.selectedIdx = -1;
      lastActiveIdx = -1;
      renderer.setEntries([]);
      renderList();
      updateViews();
      el.overlay.hidden = true;
    }

    // ── Timeline drag-to-align ──
    function initTimeline() {
      let drag = null;
      el.canvas.addEventListener('pointerdown', (e) => {
        const idx = renderer.blockAtX(e.clientX);
        if (idx >= 0) {
          drag = { idx, startX: e.clientX, moved: false };
          el.canvas.classList.add('dragging-block');
          el.canvas.setPointerCapture(e.pointerId);
        } else {
          global.Player.seekTo(renderer.timeAtX(e.clientX));
        }
      });
      el.canvas.addEventListener('pointermove', (e) => {
        if (!drag) return;
        if (Math.abs(e.clientX - drag.startX) > 4) drag.moved = true;
        if (drag.moved) {
          const t = renderer.timeAtX(e.clientX);
          renderer.setViewCenter(t);
          state.offsetMs = Math.round(t * 1000 - state.entries[drag.idx].origStartMs);
          renderer.setOffset(state.offsetMs);
          updateOffsetDisplay();
        }
      });
      el.canvas.addEventListener('pointerup', (e) => {
        if (!drag) return;
        const idx = drag.idx;
        const moved = drag.moved;
        const dropMs = Math.round(renderer.timeAtX(e.clientX) * 1000);
        drag = null;
        el.canvas.classList.remove('dragging-block');
        renderer.resetView();
        if (moved) {
          applyOffset();
          renderList();
          updateViews();
          flashOffset();
          global.Player.seekTo(dropMs / 1000);
        } else {
          selectEntry(idx);
        }
      });
      el.canvas.addEventListener('pointerleave', () => {
        if (drag) { drag = null; el.canvas.classList.remove('dragging-block'); renderer.resetView(); }
      });
    }

    // toast helper used by sync actions
    function toast(msg, type) {
      if (global.toast) global.toast(msg, type);
    }

    return {
      state,
      loadSubtitle,
      renderList,
      updateActiveSubtitle,
      selectEntry,
      captureTime,
      manualAlign,
      fineTune,
      resetOffset,
      download,
      clear,
      initTimeline,
      get offsetMs() { return state.offsetMs; },
      set offsetMs(v) { state.offsetMs = v; }
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createSync;
  else global.Sync = createSync;
})(typeof globalThis !== 'undefined' ? globalThis : this);
