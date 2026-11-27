'use strict';

/*
 * Light/dark theme. Loaded in <head> without "defer" so the theme is applied
 * before the page paints (no flash of the wrong colours).
 * With no saved choice, the theme follows the device setting.
 */
(function () {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const saved = () => localStorage.getItem('sg_theme'); // 'light' | 'dark' | null

  function apply() {
    const theme = saved() || (media.matches ? 'dark' : 'light');
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#17150f' : '#1d1a16';
    const btn = document.getElementById('themeToggle');
    if (btn) {
      const next = theme === 'dark' ? 'light' : 'dark';
      btn.setAttribute('aria-label', `Switch to ${next} mode`);
      btn.title = `Switch to ${next} mode`;
      btn.setAttribute('aria-pressed', String(theme === 'dark'));
    }
  }

  apply();
  media.addEventListener('change', () => { if (!saved()) apply(); });

  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('themeToggle').addEventListener('click', () => {
      localStorage.setItem('sg_theme', root.dataset.theme === 'dark' ? 'light' : 'dark');
      apply();
    });
  });
})();
