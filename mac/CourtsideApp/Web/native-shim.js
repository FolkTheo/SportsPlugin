// Injected by the Mac app before the shared web UI (src/app) loads. It gives
// that UI the small slice of the chrome.* extension API it uses, backed by
// the Swift side through the "courtside" message handler:
//
//   storage  -> App Group UserDefaults (so the widget sees favorites)
//   fetch    -> URLSession for ESPN / DraftKings (no browser CORS limits)
//   messages -> native actions (float on desktop, open links, quit, …)
//
// Swift replies to postMessage() with a value, so every call is a promise.
(() => {
  const bridge = window.webkit?.messageHandlers?.courtside;
  if (!bridge) return;
  const call = (message) => bridge.postMessage(message);

  // -------------------------------------------------------------- storage
  const listeners = new Set();

  function pick(all, keys) {
    if (keys === null || keys === undefined) return { ...all };
    if (typeof keys === 'string') keys = [keys];
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (k in all) out[k] = all[k];
      return out;
    }
    // Object form: keys with default values.
    const out = { ...keys };
    for (const k of Object.keys(keys)) if (k in all) out[k] = all[k];
    return out;
  }

  const area = (name) => ({
    async get(keys) {
      const json = await call({ type: 'storage-get', area: name });
      return pick(JSON.parse(json || '{}'), keys);
    },
    async set(items) {
      await call({ type: 'storage-set', area: name, items: JSON.stringify(items) });
    },
    async remove(keys) {
      await call({ type: 'storage-remove', area: name, keys: [].concat(keys) });
    },
  });

  // Swift calls this in every web view after any change, like chrome.storage.onChanged.
  window.__courtsideStorageChanged = (areaName, changes) => {
    for (const fn of listeners) {
      try {
        fn(changes, areaName);
      } catch (err) {
        console.error(err);
      }
    }
  };

  // ---------------------------------------------------------------- fetch
  const API = /^https:\/\/(site\.api\.espn\.com|sportsbook-nash\.draftkings\.com)\//;
  const pageFetch = window.fetch.bind(window);

  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (!API.test(url || '')) return pageFetch(input, init);
    return new Promise((resolve, reject) => {
      const signal = init.signal;
      const aborted = () => reject(new DOMException('The request was aborted.', 'AbortError'));
      if (signal?.aborted) return aborted();
      signal?.addEventListener('abort', aborted, { once: true });
      call({ type: 'fetch', url }).then(
        (res) => {
          try {
            resolve(new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } }));
          } catch (err) {
            reject(new TypeError(`Network request failed: ${err.message}`)); // e.g. an unusual status code
          }
        },
        (err) => reject(new TypeError(`Network request failed: ${err?.message || err}`)),
      );
    });
  };

  // -------------------------------------------------------------- runtime
  async function sendMessage(msg) {
    switch (msg?.type) {
      case 'open-popout':
        await call({ type: 'open-floating' });
        return { ok: true };
      case 'toggle-overlay':
        return { ok: false, error: 'Use "Float on desktop" to keep scores on top of other apps.' };
      default:
        return { ok: false, error: `Not available in the Mac app: ${msg?.type}` };
    }
  }

  window.courtsideNative = { platform: 'mac', call };
  window.chrome = {
    runtime: {
      id: 'courtside-mac',
      getURL: (path) => new URL(`/${String(path).replace(/^\//, '')}`, location.origin).href,
      sendMessage,
    },
    storage: {
      sync: area('sync'),
      local: area('local'),
      session: area('session'),
      onChanged: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      },
    },
    tabs: {
      create: ({ url }) => call({ type: 'open-url', url }),
      query: async () => [],
    },
  };
})();
