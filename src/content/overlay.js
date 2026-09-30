// Injected on demand (toolbar button or Alt+Shift+S) to float the scores app
// over the current page. Running it again removes the overlay.
//
// The overlay is a closed shadow root holding a small title bar and an iframe
// of the extension's own app page, so page CSS can't touch it and the app
// keeps its extension privileges.

(() => {
  if (window.__courtsideOverlay) {
    window.__courtsideOverlay.destroy();
    return;
  }

  const STORAGE_KEY = 'overlay';
  const MARGIN = 12;
  const BAR_HEIGHT = 28;
  const MIN_W = 260;
  const MIN_H = 180;
  const OPACITY_STEPS = [1, 0.9, 0.75, 0.6, 0.45];
  const UNCONTAINABLE = new Set(['VIDEO', 'IFRAME', 'IMG', 'CANVAS', 'OBJECT', 'EMBED']);

  const box = {
    width: 360,
    height: 540,
    left: null,
    top: MARGIN,
    opacity: 1,
    minimized: false,
  };

  const host = document.createElement('div');
  host.setAttribute('data-courtside-overlay', '');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; display: block;';
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .frame {
        position: absolute; inset: 0;
        display: flex; flex-direction: column;
        background: #0d1117; color: #e8edf3;
        border: 1px solid #2b3440; border-radius: 12px; overflow: hidden;
        box-shadow: 0 12px 40px rgba(0,0,0,.55);
        font: 12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
        transition: opacity .15s ease;
      }
      .bar {
        flex: none; height: ${BAR_HEIGHT}px;
        display: flex; align-items: center; gap: 4px;
        padding: 0 4px 0 8px;
        background: #161b22; border-bottom: 1px solid #2b3440;
        cursor: grab; user-select: none; touch-action: none;
      }
      .dragging .bar { cursor: grabbing; }
      .grip { color: #8b98a8; letter-spacing: -2px; margin-right: 4px; }
      .title { font-weight: 700; flex: 1; white-space: nowrap; overflow: hidden; }
      button {
        all: unset; box-sizing: border-box;
        width: 22px; height: 22px; border-radius: 6px;
        display: grid; place-items: center;
        color: #c9d3de; cursor: pointer; font-size: 14px; line-height: 1;
      }
      button:hover, button:focus-visible { background: #2b3440; color: #fff; }
      .pct { font-size: 10px; color: #8b98a8; min-width: 26px; text-align: right; }
      iframe { flex: 1; width: 100%; border: 0; display: block; background: #0d1117; color-scheme: dark; }
      .minimized iframe, .minimized .resize { display: none; }
      .resize {
        position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
        cursor: nwse-resize; touch-action: none;
        background: linear-gradient(135deg, transparent 50%, #3d4a5a 50%, #3d4a5a 60%, transparent 60%, transparent 70%, #3d4a5a 70%, #3d4a5a 80%, transparent 80%);
      }
      .shield { position: absolute; inset: ${BAR_HEIGHT}px 0 0; display: none; }
      .dragging .shield { display: block; }
    </style>
    <div class="frame" part="frame">
      <div class="bar" title="Drag to move">
        <span class="grip">⋮⋮</span>
        <span class="title">Courtside</span>
        <span class="pct"></span>
        <button data-a="opacity" title="Change transparency" aria-label="Change transparency">◐</button>
        <button data-a="minimize" title="Minimize" aria-label="Minimize">–</button>
        <button data-a="close" title="Close (Alt+Shift+S)" aria-label="Close">×</button>
      </div>
      <iframe title="Courtside live scores" allow="clipboard-write"></iframe>
      <div class="shield"></div>
      <div class="resize" title="Drag to resize"></div>
    </div>`;

  const frame = shadow.querySelector('.frame');
  const bar = shadow.querySelector('.bar');
  const iframe = shadow.querySelector('iframe');
  const pct = shadow.querySelector('.pct');
  const minimizeBtn = shadow.querySelector('[data-a="minimize"]');
  const resizeHandle = shadow.querySelector('.resize');
  iframe.src = chrome.runtime.getURL('src/app/app.html?mode=overlay');

  // ------------------------------------------------------------ geometry

  function viewport() {
    const fs = currentContainer();
    if (fs !== document.documentElement) {
      const r = fs.getBoundingClientRect();
      return { w: r.width || innerWidth, h: r.height || innerHeight };
    }
    return { w: document.documentElement.clientWidth || innerWidth, h: document.documentElement.clientHeight || innerHeight };
  }

  function clamp() {
    const { w, h } = viewport();
    box.width = Math.max(MIN_W, Math.min(box.width, w - 2 * MARGIN));
    box.height = Math.max(MIN_H, Math.min(box.height, h - 2 * MARGIN));
    if (box.left === null) box.left = w - box.width - MARGIN - 8;
    const height = box.minimized ? BAR_HEIGHT + 2 : box.height;
    box.left = Math.max(0, Math.min(box.left, w - box.width));
    box.top = Math.max(0, Math.min(box.top, h - height));
  }

  function apply() {
    clamp();
    const height = box.minimized ? BAR_HEIGHT + 2 : box.height;
    Object.assign(host.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${height}px`,
    });
    frame.classList.toggle('minimized', box.minimized);
    frame.style.opacity = frame.matches(':hover') ? 1 : box.opacity;
    pct.textContent = box.opacity < 1 ? `${Math.round(box.opacity * 100)}%` : '';
    minimizeBtn.textContent = box.minimized ? '▢' : '–';
    minimizeBtn.title = box.minimized ? 'Restore' : 'Minimize';
  }

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      chrome.storage.local.set({ [STORAGE_KEY]: { ...box } }).catch(() => {});
    }, 200);
  }

  // Transparency only applies while the pointer is elsewhere, so the scores
  // fade into the video but are fully readable when you reach for them.
  frame.addEventListener('pointerenter', () => (frame.style.opacity = 1));
  frame.addEventListener('pointerleave', () => (frame.style.opacity = box.opacity));

  // ------------------------------------------------------------ dragging & resizing

  function track(handle, onMove) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      const start = { x: e.clientX, y: e.clientY, ...box };
      handle.setPointerCapture(e.pointerId);
      frame.classList.add('dragging');
      const move = (ev) => {
        onMove(ev.clientX - start.x, ev.clientY - start.y, start);
        apply();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        frame.classList.remove('dragging');
        save();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  track(bar, (dx, dy, start) => {
    box.left = start.left + dx;
    box.top = start.top + dy;
  });

  track(resizeHandle, (dx, dy, start) => {
    box.width = start.width + dx;
    box.height = start.height + dy;
  });

  bar.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    box.minimized = !box.minimized;
    apply();
    save();
  });

  // ------------------------------------------------------------ buttons

  shadow.addEventListener('click', (e) => {
    const action = e.target.closest('button')?.dataset.a;
    if (action === 'close') destroy();
    else if (action === 'minimize') {
      box.minimized = !box.minimized;
      apply();
      save();
    } else if (action === 'opacity') {
      const i = OPACITY_STEPS.indexOf(box.opacity);
      box.opacity = OPACITY_STEPS[(i + 1) % OPACITY_STEPS.length];
      apply();
      frame.style.opacity = 1; // pointer is over the button
      save();
    }
  });

  // ------------------------------------------------------------ fullscreen

  // When a site puts its player in fullscreen, only that element is painted.
  // Move the overlay inside it so it stays visible over the game.
  function currentContainer() {
    const fs = document.fullscreenElement;
    return fs && !UNCONTAINABLE.has(fs.tagName) ? fs : document.documentElement;
  }

  function place() {
    const container = currentContainer();
    if (host.parentNode !== container) container.appendChild(host);
    apply();
  }

  const onResize = () => apply();
  document.addEventListener('fullscreenchange', place);
  window.addEventListener('resize', onResize);

  // ------------------------------------------------------------ lifecycle

  function destroy() {
    document.removeEventListener('fullscreenchange', place);
    window.removeEventListener('resize', onResize);
    host.remove();
    delete window.__courtsideOverlay;
  }

  window.__courtsideOverlay = { destroy };

  chrome.storage.local
    .get(STORAGE_KEY)
    .then((saved) => Object.assign(box, saved?.[STORAGE_KEY] || {}))
    .catch(() => {})
    .finally(place);
})();
