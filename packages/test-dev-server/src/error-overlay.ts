/**
 * Client-side build-error overlay, served by the dev server.
 *
 * This is the test-dev-server's stand-in for Vite's client error overlay. The
 * shared rolldown HMR runtime (`crates/rolldown_plugin_hmr/.../runtime-extra-dev-default.js`)
 * is intentionally NOT modified — instead this snippet is injected into the
 * served HTML (the generated index.html AND the "Bundling in progress"
 * fallback). It runs as its own lightweight websocket client alongside the
 * rolldown HMR runtime: it renders `{ type: 'error' }` messages (broadcast on
 * every build break and replayed on reconnect, so the overlay survives a
 * refresh), clears on a successful `hmr:update`, and reloads on `hmr:reload`
 * (which doubles as the spinner's reload mechanism).
 */
export function overlayClientScript(): string {
  return /* js */ `
const OVERLAY_ID = 'rolldown-error-overlay';
function clearOverlay() {
  const el = document.getElementById(OVERLAY_ID);
  if (el) el.remove();
}
function showOverlay(message, stack) {
  clearOverlay();
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute(
    'style',
    'position:fixed;inset:0;z-index:99999;margin:0;background:rgba(0,0,0,0.85);'
      + 'color:#ff5555;font-family:monospace;font-size:14px;line-height:1.5;'
      + 'padding:24px;white-space:pre-wrap;overflow:auto;',
  );
  overlay.textContent = stack || message;
  document.body.appendChild(overlay);
}
const clientId = crypto.randomUUID();
const socket = new WebSocket('ws://' + location.host + '?clientId=' + clientId);
socket.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'error') {
    showOverlay(data.message, data.stack);
  } else if (data.type === 'hmr:update' || data.type === 'build:ok') {
    clearOverlay();
  } else if (data.type === 'hmr:reload') {
    location.reload();
  }
};
`;
}

/** Inject the overlay client script before `</body>` (or append it). */
export function injectOverlayScript(html: string): string {
  const tag = `<script type="module">${overlayClientScript()}</script>`;
  if (html.includes('</body>')) {
    return html.replace('</body>', `${tag}\n</body>`);
  }
  return html + tag;
}
