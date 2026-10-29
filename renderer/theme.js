'use strict';
// Skins. The actual colors live in styles.css (:root[data-theme=...]). This file just remembers
// which one you picked and draws the little previews in Settings.
(function () {
  const LIST = [
    { id: 'allie', name: 'Allie Fern', cream: '#fff8f0', ink: '#141414', chart: '#ceff00', pink: '#ff5fa2', side: '#141414' },
    { id: 'bubblegum', name: 'bubblegum', cream: '#fff0f7', ink: '#3b0a2a', chart: '#ff9ed1', pink: '#7fd8ff', side: '#3b0a2a' },
    { id: 'ocean', name: 'ocean', cream: '#eefaff', ink: '#072b44', chart: '#5ee0ff', pink: '#ff8a5b', side: '#072b44' },
    { id: 'sunset', name: 'sunset', cream: '#fff4e6', ink: '#3a1408', chart: '#ffb347', pink: '#ff4f6d', side: '#3a1408' },
    { id: 'matcha', name: 'matcha', cream: '#f4f8e8', ink: '#1c2b14', chart: '#b6e36b', pink: '#ff8fa3', side: '#1c2b14' },
    { id: 'lavender', name: 'lavender', cream: '#f6f1ff', ink: '#251046', chart: '#c9a8ff', pink: '#ff7ac8', side: '#251046' },
    { id: 'cherry', name: 'cherry', cream: '#fff1f1', ink: '#3f0713', chart: '#ff6b81', pink: '#ffd23f', side: '#3f0713' },
    { id: 'cocoa', name: 'cocoa', cream: '#fbf1e4', ink: '#2e1a0f', chart: '#e9b872', pink: '#e8785a', side: '#2e1a0f' },
    { id: 'midnight', name: 'midnight', cream: '#15132b', ink: '#f3eeff', chart: '#a58bff', pink: '#ff6fb5', side: '#0d0b1f' },
    { id: 'terminal', name: 'terminal', cream: '#07140d', ink: '#c8ffd9', chart: '#39ff88', pink: '#ffd23f', side: '#04100a' },
  ];
  const KEY = 'huddle-theme';

  function stored() {
    try {
      const v = localStorage.getItem(KEY);
      return LIST.some((t) => t.id === v) ? v : 'allie';
    } catch (_) {
      return 'allie';
    }
  }

  function apply(id, save) {
    if (!LIST.some((t) => t.id === id)) id = 'allie';
    if (id === 'allie') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', id);
    if (save) {
      try {
        localStorage.setItem(KEY, id);
      } catch (_) {}
    }
    document.dispatchEvent(new CustomEvent('huddle-theme', { detail: id }));
  }

  window.HuddleThemes = { list: LIST, current: stored, apply: (id) => apply(id, true) };
  apply(stored(), false);
})();
