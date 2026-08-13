const $ = (s) => document.querySelector(s);
const input = $('#file-input'), hero = $('#drop-zone'), workspace = $('#workspace'), processing = $('#processing'), cancelConfirm = $('#cancel-confirm'), backgroundDialog = $('#background-dialog'), toast = $('#toast');
const canvas = $('#editor-canvas'), paintSurface = $('#paint-surface'), stage = $('#canvas-stage'), ctx = canvas.getContext('2d', { willReadFrequently: true });
const reference = $('#restore-reference'), cursor = $('#brush-cursor'), backgroundLayer = $('#background-layer');
const layer = document.createElement('canvas'), mask = document.createElement('canvas'), lctx = layer.getContext('2d'), mctx = mask.getContext('2d');
let run = 0, processingNow = false, entries = [], active = -1, originalUrl = '', sourceName = 'greenapple', restoreImage = null, currentWorker = null;
let mode = 'erase', brushSize = 52, drawing = false, lastPoint = null, history = [], historyIndex = -1, noticeTimer = 0, cursorPosition = null;
let backgroundColor = 'transparent', backgroundImage = null, backgroundImageUrl = '';

function say(v) { toast.textContent = v; toast.classList.add('show'); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => toast.classList.remove('show'), 3000); }
function status(title, detail, percent) { $('#progress-title').textContent = title; $('#progress-detail').textContent = detail; $('#progress-bar').style.width = `${Math.max(4, Math.min(100, percent))}%`; }
function supported(file) { return Boolean(file && (['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name || ''))); }
function collect(data) { const source = data?.files?.length ? [...data.files] : data?.items ? [...data.items].filter((x) => x.type?.startsWith('image/')).map((x) => x.getAsFile()) : []; return source.filter(supported); }
function stem(file, fallback) { return (file.name || fallback).replace(/\.[^/.]+$/, ''); }
function loadImage(source) { return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = source; }); }
async function hasTransparency(blob) { const url = URL.createObjectURL(blob); try { const img = await loadImage(url); const probe = document.createElement('canvas'); probe.width = Math.min(img.naturalWidth, 96); probe.height = Math.min(img.naturalHeight, 96); const probeCtx = probe.getContext('2d'); probeCtx.drawImage(img, 0, 0, probe.width, probe.height); const alpha = probeCtx.getImageData(0, 0, probe.width, probe.height).data; for (let i = 3; i < alpha.length; i += 4) if (alpha[i] < 245) return true; return false; } finally { URL.revokeObjectURL(url); } }
function cleanOriginal() { if (originalUrl) URL.revokeObjectURL(originalUrl); originalUrl = ''; }

processing.classList.add('hidden'); cancelConfirm.classList.add('hidden'); backgroundDialog.classList.add('hidden'); workspace.classList.add('hidden'); hero.classList.remove('hidden');
input.addEventListener('change', (e) => begin(collect({ files: e.target.files })));
['dragenter', 'dragover'].forEach((n) => hero.addEventListener(n, (e) => { e.preventDefault(); hero.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((n) => hero.addEventListener(n, (e) => { e.preventDefault(); hero.classList.remove('dragging'); }));
hero.addEventListener('drop', (e) => begin(collect(e.dataTransfer)));
document.addEventListener('dragover', (e) => e.preventDefault()); document.addEventListener('drop', (e) => e.preventDefault());
document.addEventListener('paste', (e) => { const files = collect(e.clipboardData); if (files.length) { e.preventDefault(); begin(files); } });
$('#cancel-button').onclick = () => { if (processingNow) cancelConfirm.classList.remove('hidden'); };
$('#continue-button').onclick = () => cancelConfirm.classList.add('hidden'); $('#keep-results-button').onclick = () => cancelBatch(true); $('#discard-results-button').onclick = () => cancelBatch(false);
$('#download-button').onclick = downloadCurrent; $('#download-all-button').onclick = downloadAll; $('#background-button').onclick = () => backgroundDialog.classList.remove('hidden'); $('#close-background').onclick = () => backgroundDialog.classList.add('hidden'); $('#clear-background').onclick = clearBackground;
$('#erase-button').onclick = () => setMode('erase'); $('#restore-button').onclick = () => setMode('restore'); $('#undo-button').onclick = undo; $('#redo-button').onclick = redo;
$('#previous-image').onclick = () => switchEntry(-1); $('#next-image').onclick = () => switchEntry(1);
$('#brush-size').oninput = (e) => { brushSize = Number(e.target.value); $('#brush-value').textContent = `${brushSize} px`; updateCursorSize(); };
$('#hold-original-button').onpointerdown = showOriginal; ['pointerup', 'pointerleave', 'pointercancel'].forEach((n) => $('#hold-original-button').addEventListener(n, hideOriginal));
$('#background-color').oninput = (e) => setColor(e.target.value); $('#background-hex').onchange = (e) => setColor(e.target.value); $('#eyedropper-button').onclick = pickColor; $('#background-file').onchange = (e) => setBackgroundImage(e.target.files[0]); document.querySelectorAll('.swatch').forEach((b) => b.onclick = () => setColor(b.dataset.color));
paintSurface.onpointerdown = startDraw; paintSurface.onpointermove = draw; paintSurface.onpointerup = endDraw; paintSurface.onpointercancel = endDraw; paintSurface.onpointerleave = () => cursor.classList.add('hidden'); paintSurface.onpointerenter = moveCursor;
stage.addEventListener('pointermove', moveCursor);
stage.addEventListener('pointerleave', () => cursor.classList.add('hidden'));
window.addEventListener('resize', fitCanvasToStage);
document.addEventListener('keydown', (e) => { if (!(e.ctrlKey || e.metaKey) || e.altKey) return; if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); } if (e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); } });


function removeInWorker(file, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = currentWorker = new Worker('removal-worker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data);
      if (data.type === 'done') { if (currentWorker === worker) currentWorker = null; worker.terminate(); resolve(data.blob); }
      if (data.type === 'error') { if (currentWorker === worker) currentWorker = null; worker.terminate(); reject(new Error(data.message)); }
    };
    worker.onerror = () => { if (currentWorker === worker) currentWorker = null; worker.terminate(); reject(new Error('Worker failed')); };
    worker.postMessage({ type: 'remove', file });
  });
}
async function begin(files) {
  if (!files.length) { say('\u8bf7\u9009\u62e9 PNG\u3001JPG \u6216 WEBP \u56fe\u7247'); return; }
  if (processingNow) { say('\u6b63\u5728\u5904\u7406\uff0c\u8bf7\u5148\u53d6\u6d88\u6216\u7b49\u5f85\u5b8c\u6210'); return; }
  const id = ++run; entries = files.map((file) => ({ file, name: stem(file, 'greenapple'), blob: null, done: false })); active = -1; processingNow = true; hero.classList.add('hidden'); workspace.classList.add('hidden'); processing.classList.remove('hidden');
  try {
    for (let index = 0; index < entries.length && id === run; index += 1) {
      const entry = entries[index];
      status('\u6b63\u5728\u79fb\u9664\u80cc\u666f\u2026', `\u6b63\u5728\u62a0\u56fe ${index + 1} / ${entries.length}\uff1a${entry.file.name || '\u56fe\u7247'}`, Math.min(92, index / entries.length * 100 + 3));
      entry.blob = await removeInWorker(entry.file, ({ key, current, total }) => { if (id !== run) return; const local = total ? Math.min(1, current / total) : .5; const safePercent = Math.min(92, (index + local * .82) / entries.length * 100); status(key === 'fetch:progress' ? '\u6b63\u5728\u51c6\u5907 AI \u6a21\u578b\u2026' : '\u6b63\u5728\u79fb\u9664\u80cc\u666f\u2026', `\u6b63\u5728\u62a0\u56fe ${index + 1} / ${entries.length}\uff1a${entry.file.name || '\u56fe\u7247'}`, safePercent); });
      if (id !== run) break;
      if (!await hasTransparency(entry.blob)) throw new Error('The model returned an opaque image');
      entry.done = true; if (index === 0) await openEntry(0);
    }
    if (id === run) { status('\u5904\u7406\u5b8c\u6210', '\u900f\u660e PNG \u5df2\u751f\u6210', 100); finish(); }
  } catch (error) { if (id === run) { console.error(error); say('\u6a21\u578b\u52a0\u8f7d\u6216\u5904\u7406\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc'); finish(); } }
  finally { input.value = ''; }
}
function finish() { processingNow = false; processing.classList.add('hidden'); const done = entries.filter((x) => x.done).length; if (!done) { hero.classList.remove('hidden'); return; } workspace.classList.remove('hidden'); $('#result-status').textContent = entries.length > 1 ? `\u5df2\u5b8c\u6210 ${done} / ${entries.length} \u5f20` : '\u5904\u7406\u5b8c\u6210'; $('#download-all-button').classList.toggle('hidden', done < 2); updateNavigation(); }
function stopWorker() { if (currentWorker) { currentWorker.postMessage({ type: 'cancel' }); currentWorker.terminate(); currentWorker = null; } }
function cancelBatch(keep) { cancelConfirm.classList.add('hidden'); ++run; stopWorker(); processingNow = false; processing.classList.add('hidden'); input.value = ''; if (!keep) { reset(); say('\u5df2\u5168\u90e8\u53d6\u6d88'); return; } entries = entries.filter((x) => x.done); if (!entries.length) { reset(); say('\u6ca1\u6709\u5df2\u5b8c\u6210\u7684\u56fe\u7247'); return; } openEntry(0).then(finish); }
async function openEntry(index) { const entry = entries[index]; if (!entry?.done) return; active = index; sourceName = entry.name; cleanOriginal(); originalUrl = URL.createObjectURL(entry.file); const resultUrl = URL.createObjectURL(entry.blob); try { const [cutout, original] = await Promise.all([loadImage(resultUrl), loadImage(originalUrl)]); canvas.width = cutout.naturalWidth; canvas.height = cutout.naturalHeight; paintSurface.width = stage.clientWidth; paintSurface.height = stage.clientHeight; layer.width = mask.width = canvas.width; layer.height = mask.height = canvas.height; ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(cutout, 0, 0); restoreImage = original; reference.src = originalUrl; $('#original-size').textContent = `${canvas.width} x ${canvas.height}`; history = []; historyIndex = -1; saveHistory(); applyBackground(); updateNavigation(); requestAnimationFrame(fitCanvasToStage); } finally { URL.revokeObjectURL(resultUrl); } }
function fitCanvasToStage() { if (!stage || !canvas.width || !canvas.height) return; const availableWidth = stage.clientWidth, availableHeight = stage.clientHeight; if (!availableWidth || !availableHeight) return; const scale = Math.min(availableWidth / canvas.width, availableHeight / canvas.height); canvas.style.width = `${Math.max(1, Math.floor(canvas.width * scale))}px`; canvas.style.height = `${Math.max(1, Math.floor(canvas.height * scale))}px`; requestAnimationFrame(syncReferenceGeometry); }
function syncReferenceGeometry() { if (!stage || !canvas || !reference || !canvas.width || !canvas.height) return; const sr = stage.getBoundingClientRect(), cr = canvas.getBoundingClientRect(); if (!cr.width || !cr.height) return; reference.style.inset = 'auto'; reference.style.left = `${cr.left - sr.left}px`; reference.style.top = `${cr.top - sr.top}px`; reference.style.width = `${cr.width}px`; reference.style.height = `${cr.height}px`; }
async function switchEntry(change) { const completed = entries.map((x, i) => x.done ? i : -1).filter((i) => i >= 0), position = completed.indexOf(active), next = completed[position + change]; if (next === undefined) return; await saveCurrent(); await openEntry(next); }
function updateNavigation() { const all = entries.filter((x) => x.done).length > 1; $('#previous-image').classList.toggle('hidden', !all); $('#next-image').classList.toggle('hidden', !all); $('#previous-image').disabled = !all || !entries.slice(0, active).some((x) => x.done); $('#next-image').disabled = !all || !entries.slice(active + 1).some((x) => x.done); }
function reset() { ++run; stopWorker(); processingNow = false; processing.classList.add('hidden'); cancelConfirm.classList.add('hidden'); backgroundDialog.classList.add('hidden'); cleanOriginal(); entries = []; active = -1; canvas.width = canvas.height = 1; restoreImage = null; reference.removeAttribute('src'); history = []; historyIndex = -1; updateHistory(); clearBackground(); workspace.classList.add('hidden'); hero.classList.remove('hidden'); $('#download-all-button').classList.add('hidden'); updateNavigation(); }
function setMode(next) { mode = next; $('#erase-button').classList.toggle('selected', next === 'erase'); $('#restore-button').classList.toggle('selected', next === 'restore'); stage.classList.toggle('show-reference', next === 'restore'); }
function point(e) { const rect = paintSurface.getBoundingClientRect(); const imageRect = canvas.getBoundingClientRect(); return { x: (e.clientX - imageRect.left) * canvas.width / imageRect.width, y: (e.clientY - imageRect.top) * canvas.height / imageRect.height }; }
function updateCursorSize() { if (!canvas.width) return; const imageRect = canvas.getBoundingClientRect(), scale = Math.max(.1, imageRect.width / Math.max(1, canvas.width)); const diameter = Math.max(1, brushSize * scale); cursor.style.width = `${diameter}px`; cursor.style.height = `${diameter}px`; }
function moveCursor(e) { const rect = stage.getBoundingClientRect(); cursorPosition = { x: e.clientX - rect.left, y: e.clientY - rect.top }; syncReferenceGeometry(); cursor.classList.remove('hidden'); cursor.style.left = `${cursorPosition.x}px`; cursor.style.top = `${cursorPosition.y}px`; updateCursorSize(); }
function startDraw(e) { if (!restoreImage) return; const imageRect = canvas.getBoundingClientRect(); if (e.clientX < imageRect.left || e.clientX > imageRect.right || e.clientY < imageRect.top || e.clientY > imageRect.bottom) return; e.preventDefault(); paintSurface.setPointerCapture(e.pointerId); drawing = true; lastPoint = point(e); moveCursor(e); paint(lastPoint, lastPoint); }
function draw(e) { moveCursor(e); if (!drawing) return; const next = point(e); paint(lastPoint, next); lastPoint = next; }
function endDraw(e) { if (!drawing) return; drawing = false; saveHistory(); if (paintSurface.hasPointerCapture(e.pointerId)) paintSurface.releasePointerCapture(e.pointerId); }
function paint(a, b) { ctx.save(); ctx.lineCap = ctx.lineJoin = 'round'; ctx.lineWidth = brushSize; if (mode === 'erase') { ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.beginPath(); ctx.arc(b.x, b.y, brushSize / 2, 0, Math.PI * 2); ctx.fill(); } else { mctx.clearRect(0, 0, mask.width, mask.height); mctx.strokeStyle = '#000'; mctx.lineCap = mctx.lineJoin = 'round'; mctx.lineWidth = brushSize; mctx.beginPath(); mctx.moveTo(a.x, a.y); mctx.lineTo(b.x, b.y); mctx.stroke(); mctx.beginPath(); mctx.arc(b.x, b.y, brushSize / 2, 0, Math.PI * 2); mctx.fill(); lctx.clearRect(0, 0, layer.width, layer.height); lctx.globalCompositeOperation = 'source-over'; lctx.drawImage(restoreImage, 0, 0, canvas.width, canvas.height); lctx.globalCompositeOperation = 'destination-in'; lctx.drawImage(mask, 0, 0); lctx.globalCompositeOperation = 'source-over'; ctx.drawImage(layer, 0, 0); } ctx.restore(); }
function saveHistory() { history = history.slice(0, historyIndex + 1); history.push(canvas.toDataURL('image/png')); if (history.length > 20) history.shift(); historyIndex = history.length - 1; updateHistory(); }
function updateHistory() { $('#undo-button').disabled = historyIndex <= 0; $('#redo-button').disabled = historyIndex >= history.length - 1; }
async function restoreHistory(index) { const image = await loadImage(history[index]); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0); historyIndex = index; updateHistory(); }
function undo() { if (historyIndex > 0) restoreHistory(historyIndex - 1); } function redo() { if (historyIndex < history.length - 1) restoreHistory(historyIndex + 1); }
function showOriginal() { stage.classList.add('holding-original'); } function hideOriginal() { stage.classList.remove('holding-original'); }
function applyBackground() { backgroundLayer.style.backgroundColor = backgroundImage ? 'transparent' : backgroundColor; backgroundLayer.style.backgroundImage = backgroundImageUrl ? `url("${backgroundImageUrl}")` : 'none'; }
function setColor(color) { if (color !== 'transparent' && !/^#[0-9a-f]{6}$/i.test(color)) { say('\u8bf7\u8f93\u5165\u6709\u6548\u989c\u8272'); return; } backgroundColor = color; backgroundImage = null; if (backgroundImageUrl) URL.revokeObjectURL(backgroundImageUrl); backgroundImageUrl = ''; $('#background-color').value = color === 'transparent' ? '#ffffff' : color; $('#background-hex').value = color === 'transparent' ? '\u900f\u660e' : color.toUpperCase(); document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('is-active', b.dataset.color === color)); applyBackground(); }
async function setBackgroundImage(file) { if (!supported(file)) return; if (backgroundImageUrl) URL.revokeObjectURL(backgroundImageUrl); backgroundImageUrl = URL.createObjectURL(file); backgroundImage = await loadImage(backgroundImageUrl); document.querySelectorAll('.swatch').forEach((b) => b.classList.remove('is-active')); applyBackground(); }
function clearBackground() { if (backgroundImageUrl) URL.revokeObjectURL(backgroundImageUrl); backgroundImageUrl = ''; backgroundImage = null; backgroundColor = 'transparent'; const hex = $('#background-hex'); if (hex) hex.value = '\u900f\u660e'; document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('is-active', b.dataset.color === 'transparent')); applyBackground(); }
async function pickColor() { if (!window.EyeDropper) { say('\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301\u5438\u8272\u7b14'); return; } try { setColor((await new EyeDropper().open()).sRGBHex); } catch (_) {} }
async function renderedBlob() { const out = document.createElement('canvas'), outCtx = out.getContext('2d'); out.width = canvas.width; out.height = canvas.height; if (backgroundImage) outCtx.drawImage(backgroundImage, 0, 0, out.width, out.height); else if (backgroundColor !== 'transparent') { outCtx.fillStyle = backgroundColor; outCtx.fillRect(0, 0, out.width, out.height); } outCtx.drawImage(canvas, 0, 0); return new Promise((resolve) => out.toBlob(resolve, 'image/png')); }
async function saveCurrent() { if (active < 0) return null; const blob = await renderedBlob(); if (blob) entries[active].blob = blob; return blob; }
function download(blob, name) { const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
async function downloadCurrent() { const blob = await saveCurrent(); if (blob) download(blob, `${sourceName}-transparent.png`); }
function dateStamp() { const d = new Date(); return `${String(d.getFullYear()).slice(-2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }
async function downloadAll() { await saveCurrent(); const done = entries.filter((x) => x.done); if (!window.JSZip) { say('\u6253\u5305\u5de5\u5177\u52a0\u8f7d\u5931\u8d25'); return; } const folder = `GAR_${dateStamp()}`, zip = new JSZip(); done.forEach((x, i) => zip.file(`${folder}/${x.name || `image-${i + 1}`}-transparent.png`, x.blob)); processing.classList.remove('hidden'); status('\u6b63\u5728\u6253\u5305\u2026', `\u5171 ${done.length} \u5f20\u56fe\u7247`, 88); try { download(await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }), `${folder}.zip`); } finally { processing.classList.add('hidden'); } }
