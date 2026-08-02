/* HTML5 video player wrapper + controls wiring. */
(function (global) {
  'use strict';

  function createPlayer() {
    const video = document.getElementById('video-player');
    const slider = document.getElementById('time-slider');
    const timeDisplay = document.getElementById('time-display');
    const playBtn = document.getElementById('play-btn');
    let onTime = null;
    let onMeta = null;
    let onPlayState = null;

    function fmt(t) { return global.SubtitleFormats.msToTimestamp(Math.max(0, t * 1000)); }

    video.addEventListener('timeupdate', () => {
      timeDisplay.textContent = fmt(video.currentTime);
      slider.value = video.currentTime;
      if (onTime) onTime(video.currentTime);
    });
    slider.addEventListener('input', () => {
      video.currentTime = parseFloat(slider.value);
    });
    video.addEventListener('play', () => {
      playBtn.textContent = '⏸ Duraklat';
      if (onPlayState) onPlayState(true);
    });
    video.addEventListener('pause', () => {
      playBtn.textContent = '▶ Oynat';
      if (onPlayState) onPlayState(false);
    });

    const Player = {
      get video() { return video; },
      init() {
        document.getElementById('play-btn').addEventListener('click', () => Player.togglePlay());
        document.getElementById('btn-minus-5').addEventListener('click', () => Player.skip(-5));
        document.getElementById('btn-minus-1').addEventListener('click', () => Player.skip(-1));
        document.getElementById('btn-plus-1').addEventListener('click', () => Player.skip(1));
        document.getElementById('btn-plus-5').addEventListener('click', () => Player.skip(5));
      },
      load(file) {
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            video.removeEventListener('loadedmetadata', handleMeta);
            video.removeEventListener('error', handleError);
            fn(arg);
          };
          const handleMeta = () => {
            slider.max = video.duration;
            if (onMeta) onMeta(video.duration);
            finish(resolve, video.duration);
          };
          const handleError = () => finish(reject, new Error('Video yüklenemedi'));
          video.addEventListener('loadedmetadata', handleMeta, { once: true });
          video.addEventListener('error', handleError, { once: true });
          if (video.src) { URL.revokeObjectURL(video.src); }
          video.src = URL.createObjectURL(file);
        });
      },
      get currentTime() { return video.currentTime; },
      get duration() { return video.duration || 0; },
      seekTo(t) { video.currentTime = Math.max(0, Math.min(video.duration || Infinity, t)); },
      skip(sec) { Player.seekTo(video.currentTime + sec); },
      togglePlay() { if (video.paused) { const p = video.play(); if (p && p.catch) p.catch(() => {}); } else { video.pause(); } },
      onTime(cb) { onTime = cb; },
      onMeta(cb) { onMeta = cb; },
      onPlayState(cb) { onPlayState = cb; },
      cleanup() {
        URL.revokeObjectURL(video.src);
        video.src = '';
        slider.max = 0;
        slider.value = 0;
        timeDisplay.textContent = '00:00:00,000';
        playBtn.textContent = '▶ Oynat';
      }
    };

    return Player;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = createPlayer;
  else global.Player = createPlayer();
})(typeof globalThis !== 'undefined' ? globalThis : this);
