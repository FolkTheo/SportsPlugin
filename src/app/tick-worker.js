// Timers on a hidden page (e.g. the pop-out window left behind when scores
// float on top) are heavily throttled by Chrome. Timers in a dedicated worker
// are not, so refresh scheduling runs through here.
let pending = null;

self.onmessage = ({ data }) => {
  clearTimeout(pending);
  if (data && data.delay >= 0) {
    pending = setTimeout(() => self.postMessage(data.id), data.delay);
  }
};
