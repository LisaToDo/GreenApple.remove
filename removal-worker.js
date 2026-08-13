let backgroundModule;
let stopped = false;

async function getModule() {
  if (!backgroundModule) {
    try {
      backgroundModule = await import('https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm');
    } catch (_) {
      backgroundModule = await import('https://unpkg.com/@imgly/background-removal@1.7.0/dist/index.mjs');
    }
  }
  return backgroundModule;
}

self.onmessage = async ({ data }) => {
  if (data.type === 'cancel') { stopped = true; self.close(); return; }
  if (data.type !== 'remove') return;
  stopped = false;
  try {
    const module = await getModule();
    const blob = await module.removeBackground(data.file, {
      // Medium runs entirely in the browser and generally preserves finer
      // edges/details than the small model. It uses no Codex/OpenAI token.
      model: 'medium',
      progress: (key, current, total) => {
        if (!stopped) self.postMessage({ type: 'progress', key, current, total });
      }
    });
    if (!stopped) self.postMessage({ type: 'done', blob });
  } catch (error) {
    if (!stopped) self.postMessage({ type: 'error', message: error?.message || 'Background removal failed' });
  }
};
