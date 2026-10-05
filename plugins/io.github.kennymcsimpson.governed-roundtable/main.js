"use strict";
// Entry module PI-Desktop loads for this plugin. The host requires main.js inside the plugin's own
// utilityProcess after setting globalThis.pi (plugin-host-process.mjs handleInit / loadPluginModule),
// then calls onLoad, starts the declared service, and forwards panel channels it does not handle
// itself to onPanelInvoke. Everything else lives in core.mjs (ESM, like the vendored room-dev engine
// under ./room-dev/), imported here by a literal relative specifier.

let loading = null;
let plugin = null;

function loadCore() {
  if (!loading) loading = import("./core.mjs");
  return loading;
}

async function onLoad() {
  const { createRoundtablePlugin } = await loadCore();
  const next = createRoundtablePlugin(globalThis.pi);
  await next.onLoad();
  plugin = next;
}

async function onUnload() {
  const current = plugin;
  plugin = null;
  if (current) await current.onUnload();
}

async function onPanelInvoke(channel, payload) {
  if (!plugin) {
    const error = new Error("Governed Roundtable is not loaded");
    error.code = "NOT_READY";
    throw error;
  }
  return plugin.onPanelInvoke(channel, payload);
}

module.exports = { onLoad, onUnload, onPanelInvoke };
