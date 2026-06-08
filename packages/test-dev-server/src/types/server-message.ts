export interface HmrUpdateMessage {
  type: 'hmr:update';
  url: string;
  path: string;
}

export interface HmrReloadMessage {
  type: 'hmr:reload';
}

export interface ConnectedMessage {
  type: 'connected';
}

/**
 * Mirrors Vite full-bundle mode: a build error is pushed to every connected
 * client and replayed to freshly-connected ones, so the error survives a
 * browser refresh. See `fullBundleEnvironment.ts` (`prepareError` + the
 * `vite:client:connect` replay) and `meta/design/dev-engine.md` §2.
 */
export interface ErrorMessage {
  type: 'error';
  message: string;
  stack?: string;
}

/**
 * Broadcast when a build recovers (errored → ok). HMR patches are delivered
 * per-client (only to the client that registered the changed module), so they
 * can't clear the error overlay on the separate overlay client — this broadcast
 * does. See `error-overlay.ts` and `FullBundleDevEnvironment`.
 */
export interface BuildOkMessage {
  type: 'build:ok';
}
