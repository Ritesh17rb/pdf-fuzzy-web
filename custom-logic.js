// custom-logic.js
// Requires: lib/pdf.js (PDF.js) and lib/fuse.min.js (Fuse.js)
// pdfjsLib should be available globally from pdf.js

pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.js';

const fileInput = document.getElementById('file-input');
const uploadArea = document.getElementById('upload-area');
const pdfContainer = document.getElementById('pdf-container');
const statusEl = document.getElementById('status');
const searchBox = document.getElementById('search-box');
const searchBtn = document.getElementById('search-btn');
const resultsPanel = document.getElementById('results');
const thresholdInput = document.getElementById('threshold');
const thresholdVal = document.getElementById('threshold-val');
const clearBtn = document.getElementById('clear-btn');
const pageCountDisplay = document.getElementById('page-count-display');

let gPdf = null;
let corpus = []; // array of {text, pageNum, x, y, width, height}
let renderedPages = new Set();
let renderQueue = Promise.resolve();

function setStatus(msg) { statusEl.textContent = msg; }

// Drag & drop + file input wiring
uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = '#8fb3ff'; });
uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = '#cfd8e3'; });
uploadArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  uploadArea.style.borderColor = '#cfd8e3';
  if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
  const f = e.dataTransfer.files[0];
  await loadPdfFile(f);
});
fileInput.addEventListener('change', async (e) => {
  if (!e.target.files || e.target.files.length === 0) return;
  await loadPdfFile(e.target.files[0]);
});
clearBtn.addEventListener('click', clearAll);

// Threshold display
thresholdInput.addEventListener('input', () => {
  thresholdVal.textContent = Number(thresholdInput.value).toFixed(2);
});

// Search wiring
searchBtn.addEventListener('click', runSearch);
searchBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

// Load PDF file (File object)
async function loadPdfFile(file) {
  if (!file) return;
  if (file.type !== 'application/pdf') {
    alert('Please provide a PDF file.');
    return;
  }

  clearAll();
  setStatus(`Reading ${file.name}...`);

  const arrayBuffer = await file.arrayBuffer();
  try {
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    gPdf = await loadingTask.promise;
    pageCountDisplay.textContent = `pages: ${gPdf.numPages}`;
    setStatus(`PDF loaded — ${gPdf.numPages} pages. Extracting text (this may take a few seconds)...`);
    // Extract text for all pages
    corpus = await extractTextCorpus(gPdf);
    setStatus(`Extracted ${corpus.length} lines. Ready to search.`);
    // Render first page for preview
    await ensurePageRendered(1);
  } catch (err) {
    console.error('Failed to load PDF:', err);
    setStatus('Error loading PDF. See console.');
  }
}

// Clear UI + state
function clearAll() {
  gPdf = null;
  corpus = [];
  renderedPages.clear();
  pdfContainer.innerHTML = '';
  resultsPanel.innerHTML = '<div class="muted">No results yet.</div>';
  setStatus('No PDF loaded.');
  pageCountDisplay.textContent = 'pages: ?';
}

// Extract text corpus: returns array of objects describing lines with coordinates
async function extractTextCorpus(pdf) {
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent({ normalizeWhitespace: true });
    // Reconstruct lines roughly using y coordinate
    let lines = [];
    let current = null;
    for (const item of textContent.items) {
      const tx = item.transform;
      const x = tx[4];
      const y = tx[5];
      const w = item.width || 0;
      const h = (item.height != null) ? item.height : Math.max(Math.abs(tx[3]), 10);
      const str = item.str || '';
      if (!current) {
        current = { text: str, x, y, width: w, height: h, pageNum: i };
      } else if (Math.abs(current.y - y) <= 3) {
        const rightEdge = Math.max(current.x + current.width, x + w);
        current.width = rightEdge - current.x;
        current.text += ' ' + str;
        current.height = Math.max(current.height, h);
      } else {
        lines.push(current);
        current = { text: str, x, y, width: w, height: h, pageNum: i };
      }
    }
    if (current) lines.push(current);
    // normalize
    for (const l of lines) {
      const text = l.text.replace(/\s+/g, ' ').trim();
      if (text.length > 0) out.push({ ...l, text });
    }
  }
  return out;
}

// Render one page (with text layer)
async function renderPage(pageNum) {
  // Skip if already rendered
  const id = `page-${pageNum}`;
  if (document.getElementById(id)) return;
  const page = await gPdf.getPage(pageNum);
  const scale = 1.5;
  const viewport = page.getViewport({ scale });

  const wrapper = document.createElement('div');
  wrapper.className = 'page-wrapper';
  wrapper.id = id;
  wrapper.style.width = `${Math.ceil(viewport.width)}px`;
  wrapper.style.height = `${Math.ceil(viewport.height)}px`;

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');

  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  textLayerDiv.style.width = `${canvas.width}px`;
  textLayerDiv.style.height = `${canvas.height}px`;

  wrapper.appendChild(canvas);
  wrapper.appendChild(textLayerDiv);
  pdfContainer.appendChild(wrapper);

  // Render both in parallel
  await Promise.all([
    page.render({ canvasContext: ctx, viewport }).promise,
    pdfjsLib.renderTextLayer({
      textContent: await page.getTextContent({ normalizeWhitespace: true }),
      container: textLayerDiv,
      viewport,
      textDivs: [],
      enhanceTextSelection: true
    }).promise
  ]);

  renderedPages.add(pageNum);
}

// Ensure a page is rendered (queued sequentially)
async function ensurePageRendered(pageNum) {
  if (!gPdf) return;
  const id = `page-${pageNum}`;
  if (document.getElementById(id)) return;
  renderQueue = renderQueue.then(() => renderPage(pageNum)).catch(err => console.error('Render error', err));
  await renderQueue;
}

// Run fuzzy search using Fuse.js
async function runSearch() {
  const q = (searchBox.value || '').trim();
  if (!gPdf) return alert('Please load a PDF first.');
  if (!q || q.length < 1) return alert('Type a search phrase.');

  setStatus(`Searching for: "${q}" ...`);
  // Build fuse with current threshold
  const threshold = parseFloat(thresholdInput.value);
  const fuse = new Fuse(corpus, {
    keys: ['text'],
    threshold,
    includeScore: true,
    ignoreLocation: true,
    findAllMatches: true,
    minMatchCharLength: Math.min(3, q.length),
    distance: 1000
  });

  let results = fuse.search(q);
  // fallback substring
  if (!results || results.length === 0) {
    const ql = q.toLowerCase();
    results = corpus
      .map(item => ({ item, score: 1 }))
      .filter(r => r.item.text.toLowerCase().includes(ql));
  }

  if (!results || results.length === 0) {
    resultsPanel.innerHTML = '<div class="muted">No matches found.</div>';
    setStatus('No matches found.');
    return;
  }

  // Limit number of top matches shown
  const top = results.slice(0, 30);
  renderResults(top);
  setStatus(`Found ${results.length} matches. Showing top ${top.length}.`);
}

// Render results list and wire click handlers
function renderResults(matches) {
  if (!matches || matches.length === 0) {
    resultsPanel.innerHTML = '<div class="muted">No matches.</div>';
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'matches';
  matches.forEach((m, idx) => {
    const item = m.item || m; // fallback for substring mapped hits
    const li = document.createElement('li');
    const score = (m.score != null) ? ` (score ${m.score.toFixed(3)})` : '';
    const preview = item.text.length > 160 ? item.text.slice(0, 157) + '…' : item.text;
    const btn = document.createElement('button');
    btn.innerHTML = `${idx + 1}. Page ${item.pageNum}${score} — ${escapeHtml(preview)}`;
    btn.style = 'all:unset; color:var(--accent); cursor:pointer; text-decoration:underline;';
    btn.addEventListener('click', async () => {
      await ensurePageRendered(item.pageNum);
      document.getElementById(`page-${item.pageNum}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
      // highlight match
      const page = await gPdf.getPage(item.pageNum);
      const viewport = page.getViewport({ scale: 1.5 });
      highlightMatch(document.getElementById(`page-${item.pageNum}`), viewport, item);
    });
    li.appendChild(btn);
    ul.appendChild(li);
  });
  resultsPanel.innerHTML = '';
  resultsPanel.appendChild(ul);
}

// Simple HTML escape
function escapeHtml(s) {
  return (s + '').replace(/[&<>"]/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[ch]));
}

// Add highlight rectangle (non-blocking)
function highlightMatch(wrapper, viewport, item) {
  // remove previous highlights in this wrapper
  const existing = wrapper.querySelectorAll('.highlight');
  existing.forEach(e => e.remove());

  const { x=0, y=0, width=50, height=12 } = item;
  try {
    const rect = viewport.convertToViewportRectangle([x, y, x + width, y + height]);
    const left = Math.min(rect[0], rect[2]);
    const top = Math.min(rect[1], rect[3]);
    const w = Math.abs(rect[0] - rect[2]);
    const h = Math.abs(rect[1] - rect[3]);
    const hl = document.createElement('div');
    hl.className = 'highlight';
    hl.style.left = `${left}px`;
    hl.style.top = `${top}px`;
    hl.style.width = `${w}px`;
    hl.style.height = `${h}px`;
    wrapper.appendChild(hl);
    // Auto remove highlight after 6s
    setTimeout(() => hl.remove(), 6000);
  } catch (err) {
    console.warn('Highlight failed', err);
  }
}
