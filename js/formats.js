/* Subtitle format parsing & serialization. Pure JS, no DOM, Node-testable. */
(function (global) {
  'use strict';

  function timestampToMs(ts) {
    const m = /(\d{1,}):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(ts);
    if (!m) return -1;
    const h = parseInt(m[1], 10), min = parseInt(m[2], 10), s = parseInt(m[3], 10);
    const mil = parseInt((m[4] + '00').slice(0, 3), 10);
    return h * 3600000 + min * 60000 + s * 1000 + mil;
  }

  function msToTimestamp(ms) {
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mil = Math.floor(ms % 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    return p2(h) + ':' + p2(m) + ':' + p2(s) + ',' + String(mil).padStart(3, '0');
  }

  function makeEntry(index, startMs, endMs, text, assFields) {
    return { index, startMs, endMs, origStartMs: startMs, origEndMs: endMs, text, assFields };
  }

  // ── SRT ──

  function parseSRT(text) {
    const entries = [];
    const normalized = text.replace(/\uFEFF/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const blocks = normalized.split(/\n{2,}/);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 2) continue;
      const idx = parseInt(lines[0], 10);
      if (isNaN(idx)) continue;
      const m = /(\d{1,}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,}:\d{2}:\d{2}[,.]\d{1,3})/.exec(lines[1]);
      if (!m) continue;
      const startMs = timestampToMs(m[1]);
      const endMs = timestampToMs(m[2]);
      if (startMs < 0 || endMs < 0 || endMs < startMs) continue;
      entries.push(makeEntry(idx, startMs, endMs, lines.slice(2).join('\n').trim()));
    }
    return entries;
  }

  function serializeSRT(entries) {
    let out = '';
    for (const e of entries) {
      out += e.index + '\n';
      out += msToTimestamp(e.startMs) + ' --> ' + msToTimestamp(e.endMs) + '\n';
      out += e.text.replace(/\n/g, '\r\n') + '\r\n\r\n';
    }
    return out;
  }

  // ── VTT ──

  function parseVTT(text) {
    const entries = [];
    const normalized = text.replace(/\uFEFF/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    let i = 0;
    if (lines[i] && lines[i].indexOf('WEBVTT') === 0) i++;
    let idx = 1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') { i++; continue; }
      if (/^(NOTE|STYLE|REGION)\b/.test(line.trim())) {
        while (i < lines.length && lines[i].trim() !== '') i++;
        continue;
      }
      const m = /(\d{1,}:\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,}:\d{2}:\d{2}[.,]\d{1,3})/.exec(line);
      if (m) {
        const startMs = timestampToMs(m[1]);
        const endMs = timestampToMs(m[2]);
        i++;
        const textLines = [];
        while (i < lines.length && lines[i].trim() !== '') { textLines.push(lines[i]); i++; }
        if (startMs >= 0 && endMs >= startMs) {
          entries.push(makeEntry(idx++, startMs, endMs, textLines.join('\n').trim()));
        }
      } else {
        i++;
      }
    }
    return entries;
  }

  function msToTimestampVtt(ms) {
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mil = Math.floor(ms % 1000);
    const p2 = (n) => String(n).padStart(2, '0');
    return p2(h) + ':' + p2(m) + ':' + p2(s) + '.' + String(mil).padStart(3, '0');
  }

  function serializeVTT(entries) {
    let out = 'WEBVTT\r\n\r\n';
    for (const e of entries) {
      out += msToTimestampVtt(e.startMs) + ' --> ' + msToTimestampVtt(e.endMs) + '\r\n';
      out += e.text.replace(/\n/g, '\r\n') + '\r\n\r\n';
    }
    return out;
  }

  // ── ASS ──

  const ASS_DEFAULT_FIELDS = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text'];

  function assTimeToMs(t) {
    const m = /(\d+):(\d{1,2}):(\d{1,2})[.](\d{1,2})/.exec(t);
    if (!m) return -1;
    const h = +m[1], min = +m[2], s = +m[3];
    let cs = +m[4];
    if (m[4].length === 1) cs *= 10;
    return h * 3600000 + min * 60000 + s * 1000 + cs * 10;
  }

  function msToAssTime(ms) {
    if (ms < 0) ms = 0;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const cs = Math.floor((ms % 1000) / 10);
    const p2 = (n) => String(n).padStart(2, '0');
    return h + ':' + p2(m) + ':' + p2(s) + '.' + p2(cs);
  }

  function parseDialogueLine(line, fields) {
    const startIdx = fields.indexOf('Start');
    const endIdx = fields.indexOf('End');
    const textIdx = fields.indexOf('Text');
    if (startIdx < 0 || endIdx < 0 || textIdx < 0) return null;
    const body = line.replace(/^Dialogue\s*:/i, '').trim();
    const parts = body.split(',');
    if (parts.length < fields.length) return null;
    const values = parts.slice(0, fields.length - 1);
    const text = parts.slice(fields.length - 1).join(',').trim();
    const startMs = assTimeToMs(values[startIdx].trim());
    const endMs = assTimeToMs(values[endIdx].trim());
    if (startMs < 0 || endMs < 0 || endMs < startMs) return null;
    const assFields = fields.map((f, j) => (j === textIdx || j === startIdx || j === endIdx ? null : values[j]));
    return { startMs, endMs, text: text.replace(/\\[nN]/g, '\n'), assFields };
  }

  function parseASS(text) {
    const normalized = text.replace(/\uFEFF/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalized.split('\n');
    const headerLines = [];
    const entries = [];
    let fields = null;
    let inEvents = false;
    for (const line of lines) {
      if (/^\[Events\]/i.test(line)) { inEvents = true; headerLines.push(line); continue; }
      if (!inEvents) { headerLines.push(line); continue; }
      if (/^Dialogue\s*:/i.test(line)) {
        const d = parseDialogueLine(line, fields || ASS_DEFAULT_FIELDS);
        if (d) entries.push(makeEntry(entries.length + 1, d.startMs, d.endMs, d.text, d.assFields));
        continue;
      }
      if (/^Format\s*:/i.test(line)) {
        if (!fields) fields = line.replace(/^Format\s*:/i, '').split(',').map((s) => s.trim());
        headerLines.push(line);
        continue;
      }
      headerLines.push(line);
    }
    if (!fields) fields = ASS_DEFAULT_FIELDS.slice();
    if (entries.length && !headerLines.some((l) => /^Format\s*:/i.test(l))) {
      headerLines.push('Format: ' + fields.join(', '));
    }
    return { entries, header: headerLines.join('\n'), fields };
  }

  function serializeDialogue(e, fields) {
    const values = [];
    for (let j = 0; j < fields.length; j++) {
      const f = fields[j];
      if (f === 'Start') values.push(msToAssTime(e.startMs));
      else if (f === 'End') values.push(msToAssTime(e.endMs));
      else if (f === 'Text') values.push(e.text.replace(/\n/g, '\\N'));
      else values.push(e.assFields && e.assFields[j] != null ? e.assFields[j] : '');
    }
    return 'Dialogue: ' + values.join(',');
  }

  function serializeASS(entries, header, fields) {
    const parts = [(header || '').trim()];
    for (const e of entries) parts.push(serializeDialogue(e, fields || ASS_DEFAULT_FIELDS));
    return parts.join('\n') + '\n';
  }

  // ── detect ──

  function detect(name, content) {
    const ext = (name || '').split('.').pop().toLowerCase();
    if (content && content.indexOf('WEBVTT') === 0) return 'vtt';
    if (content && /^\[Script Info\]/m.test(content)) return 'ass';
    if (ext === 'srt') return 'srt';
    if (ext === 'vtt') return 'vtt';
    if (ext === 'ass' || ext === 'ssa') return 'ass';
    return 'srt';
  }

  // ── export ──

  const SubtitleFormats = {
    FORMATS: ['srt', 'vtt', 'ass'],
    timestampToMs,
    msToTimestamp,
    detect,
    parseSRT,
    parseVTT,
    parseASS,
    parse(text, format) {
      if (format === 'vtt') return parseVTT(text);
      if (format === 'ass') return parseASS(text).entries;
      return parseSRT(text);
    },
    serialize(entries, format, header, fields) {
      if (format === 'vtt') return serializeVTT(entries);
      if (format === 'ass') return serializeASS(entries, header, fields);
      return serializeSRT(entries);
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SubtitleFormats;
  else global.SubtitleFormats = SubtitleFormats;
})(typeof globalThis !== 'undefined' ? globalThis : this);
