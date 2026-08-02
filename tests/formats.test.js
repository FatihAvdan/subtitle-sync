'use strict';
const assert = require('assert');
const F = require('../js/formats.js');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { console.error('  FAIL - ' + name + '\n    ' + e.message); process.exitCode = 1; }
}

console.log('formats.test.js');

t('timestampToMs parses SRT timestamps', () => {
  assert.strictEqual(F.timestampToMs('00:01:23,456'), 83456);
  assert.strictEqual(F.timestampToMs('1:02:03.789'), 3723789);
  assert.strictEqual(F.timestampToMs('00:00:00,5'), 500);
  assert.strictEqual(F.timestampToMs('garbage'), -1);
});

t('msToTimestamp round-trips', () => {
  assert.strictEqual(F.msToTimestamp(83456), '00:01:23,456');
  assert.strictEqual(F.msToTimestamp(3723789), '01:02:03,789');
  assert.strictEqual(F.msToTimestamp(-500), '00:00:00,000');
});

t('SRT parse: BOM, CRLF, multiline text, malformed blocks skipped', () => {
  const raw = '\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\nMerhaba\r\ndünya\r\n\r\n' +
    '2\r\n00:00:04,000 --> 00:00:05,500\r\nİkinci satır\r\n\r\n' +
    'not a number\r\n00:00:99,000 --> 00:00:10,000\r\nbozuk\r\n\r\n' +
    '3\r\nbad timing line\r\nüçüncü\r\n';
  const e = F.parse(raw, 'srt');
  assert.strictEqual(e.length, 2);
  assert.strictEqual(e[0].index, 1);
  assert.strictEqual(e[0].startMs, 1000);
  assert.strictEqual(e[0].endMs, 3000);
  assert.strictEqual(e[0].text, 'Merhaba\ndünya');
  assert.strictEqual(e[1].index, 2);
  assert.strictEqual(e[1].startMs, 4000);
  assert.strictEqual(e[1].origStartMs, 4000);
});

t('SRT serialize round-trip', () => {
  const e = F.parse('1\n00:00:01,000 --> 00:00:03,000\nMerhaba dünya\n\n2\n00:00:04,000 --> 00:00:05,500\nSatır\ntest\n', 'srt');
  const out = F.serialize(e, 'srt');
  assert.ok(out.includes('00:00:01,000 --> 00:00:03,000'));
  assert.ok(out.includes('Merhaba dünya'));
  const re = F.parse(out, 'srt');
  assert.deepStrictEqual(re.map(x => [x.index, x.startMs, x.endMs, x.text]), e.map(x => [x.index, x.startMs, x.endMs, x.text]));
});

t('VTT parse: header, NOTE block, cue identifier, .mmm timestamps', () => {
  const raw = 'WEBVTT - test\n\nNOTE this is a comment\nblock spanning lines\n\n' +
    '01\n00:00:01.500 --> 00:00:03.250\nMerhaba vtt\n\n' +
    '00:00:04.000 --> 00:00:05.000\nİkinci\n';
  const e = F.parse(raw, 'vtt');
  assert.strictEqual(e.length, 2);
  assert.strictEqual(e[0].index, 1);
  assert.strictEqual(e[0].startMs, 1500);
  assert.strictEqual(e[0].endMs, 3250);
  assert.strictEqual(e[0].text, 'Merhaba vtt');
  assert.strictEqual(e[1].text, 'İkinci');
});

t('VTT serialize includes WEBVTT header', () => {
  const e = F.parse('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nMerhaba\n', 'vtt');
  const out = F.serialize(e, 'vtt');
  assert.ok(out.startsWith('WEBVTT'));
  assert.ok(out.includes('00:00:01.000 --> 00:00:02.000'));
});

t('ASS parse: header verbatim, dialogue fields, commas in text, \\N conversion', () => {
  const raw = '[Script Info]\nTitle: Test\n\n[V4+ Styles]\nFormat: Name, Fontname\nStyle: Default,Arial\n\n' +
    '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    'Dialogue: 0,0:00:01.00,0:00:03.25,Default,,0,0,0,,Merhaba, virgül var\\Nikinci satır\n' +
    'Comment: 0,0:00:01.00,0:00:03.25,Default,,0,0,0,,yorum satırı\n' +
    'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,{\\an8}Üçüncü\n';
  const r = F.parseASS(raw);
  assert.strictEqual(r.entries.length, 2);
  assert.strictEqual(r.entries[0].startMs, 1000);
  assert.strictEqual(r.entries[0].endMs, 3250);
  assert.strictEqual(r.entries[0].text, 'Merhaba, virgül var\nikinci satır');
  assert.strictEqual(r.entries[1].text, '{\\an8}Üçüncü');
  assert.ok(r.header.includes('[Script Info]'));
  assert.ok(r.header.includes('Title: Test'));
  assert.ok(r.header.includes('Format: Layer, Start, End'));
  assert.ok(r.header.includes('Comment: 0,0:00:01.00'));
  assert.strictEqual(r.fields[0], 'Layer');
  assert.strictEqual(r.fields[9], 'Text');
});

t('ASS serialize: header preserved, times rewritten, \\N restored', () => {
  const raw = '[Script Info]\nTitle: Test\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    'Dialogue: 0,0:00:01.00,0:00:03.25,Default,,0,0,0,,Merhaba\\Ndünya\n';
  const r = F.parseASS(raw);
  r.entries[0].startMs = 2000;
  r.entries[0].endMs = 4000;
  const out = F.serialize(r.entries, 'ass', r.header, r.fields);
  assert.ok(out.includes('[Script Info]\nTitle: Test'));
  assert.ok(out.includes('Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,Merhaba\\Ndünya'));
});

t('ASS parse without Format line falls back to defaults', () => {
  const r = F.parseASS('[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Merhaba\n');
  assert.strictEqual(r.entries.length, 1);
  assert.strictEqual(r.entries[0].startMs, 1000);
});

t('detect: extension and content sniffing', () => {
  assert.strictEqual(F.detect('film.srt', '1\n00:00:01,000 --> 00:00:02,000\nx'), 'srt');
  assert.strictEqual(F.detect('film.vtt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx'), 'vtt');
  assert.strictEqual(F.detect('film.ass', 'nothing'), 'ass');
  assert.strictEqual(F.detect('film.txt', 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nx'), 'vtt');
  assert.strictEqual(F.detect('film.txt', '[Script Info]\nTitle: x'), 'ass');
  assert.strictEqual(F.detect('film.txt', '1\n00:00:01,000 --> 00:00:02,000\nx'), 'srt');
});

console.log(passed + ' tests passed');
