require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const { processPDF, processContent } = require('./pipeline');

const app = express();
const PORT = process.env.PORT || 3005;
const TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '600000', 10); // 10 min

// Optional bearer-token auth for the API endpoints. Set API_TOKEN in .env to
// require "Authorization: Bearer <token>" on /api/upload and /api/embed.
const API_TOKEN = process.env.API_TOKEN || '';
// Comma-separated list of origins allowed to call /api/embed. Defaults to '*'
// (any origin). Set e.g. EMBED_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
const EMBED_ALLOWED_ORIGINS = process.env.EMBED_ALLOWED_ORIGINS || '*';

// Storage for uploaded PDFs and generated decks
const uploadsDir = path.join(__dirname, 'uploads');
const decksDir = path.join(__dirname, 'decks');

// Ensure directories exist
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(decksDir)) fs.mkdirSync(decksDir, { recursive: true });

// Configure multer for PDF uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/decks', express.static(decksDir));

// CORS so the iframe embed works from any embedding site. Viewer assets (GET)
// always allow any origin; POST /api/embed respects EMBED_ALLOWED_ORIGINS.
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  let allowOrigin = '*';
  if (req.method === 'POST' && EMBED_ALLOWED_ORIGINS !== '*') {
    const allowed = EMBED_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
    if (allowed.includes(origin)) allowOrigin = origin;
    else if (allowed.length) allowOrigin = ''; // block disallowed POST origins
  }
  if (allowOrigin) res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Parse JSON bodies (multer only handles multipart). Required for /api/embed.
app.use(express.json({ limit: '5mb' }));

// Optional auth middleware: if API_TOKEN is set, require it on API routes.
function requireApiToken(req, res, next) {
  if (!API_TOKEN) return next();
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${API_TOKEN}`) return next();
  res.status(401).json({ error: 'Unauthorized: missing or invalid API token' });
}

// Origin check for /api/embed when EMBED_ALLOWED_ORIGINS is restrictive.
function embedOriginAllowed(req) {
  if (EMBED_ALLOWED_ORIGINS === '*') return true;
  const origin = req.headers.origin || '';
  return EMBED_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean).includes(origin);
}

// Viewer route: render the in-browser player for a deck that has voiceover.
// Falls back to the download page if the deck is missing or has no render.json.
app.get('/decks/:deckId/view', (req, res) => {
  const deckDir = path.join(decksDir, req.params.deckId);
  const renderPath = path.join(deckDir, 'render.json');
  if (!fs.existsSync(renderPath)) {
    return res.redirect(`/decks/${req.params.deckId}/deck.pptx`);
  }
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

// Shared pipeline runner for both the synchronous /api/upload and the
// async /api/upload-async endpoints. Handles the PDF → deck pipeline,
// optional voiceover zip, and writing manifest.json / deck files.
// Returns the deckId on success; throws on failure (caller cleans up).
async function runPipeline(pdfPath, deckId, opts) {
  const deckDir = path.join(decksDir, deckId);
  fs.mkdirSync(deckDir, { recursive: true });

  const manifest = await processPDF(pdfPath, deckDir, opts);

  // If voiceover is on, build a single .zip with pptx + mp3.
  if (opts.voiceover && manifest.voiceoverUrl) {
    const zipPath = path.join(deckDir, 'deck.zip');
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(zipPath);
      const a = archiver('zip', { zlib: { level: 6 } });
      out.on('close', resolve);
      out.on('error', reject);
      a.on('error', reject);
      a.pipe(out);
      a.file(path.join(deckDir, 'deck.pptx'), { name: 'deck.pptx' });
      a.file(path.join(deckDir, 'voiceover.mp3'), { name: 'voiceover.mp3' });
      a.finalize();
    });
    const zstats = fs.statSync(zipPath);
    manifest.downloadUrl = `/decks/${deckId}/deck.zip`;
    manifest.downloadBytes = zstats.size;
    manifest.downloadFilename = 'deck.zip';
  } else {
    manifest.downloadUrl = `/decks/${deckId}/deck.pptx`;
    manifest.downloadBytes = manifest.pptxBytes || 0;
    manifest.downloadFilename = 'deck.pptx';
  }

  return manifest;
}

// Writes a status.json into the deck dir so async clients can poll progress.
function writeDeckStatus(deckId, status, extra) {
  try {
    const deckDir = path.join(decksDir, deckId);
    fs.mkdirSync(deckDir, { recursive: true });
    fs.writeFileSync(
      path.join(deckDir, 'status.json'),
      JSON.stringify({ deckId, status, updatedAt: new Date().toISOString(), ...extra }, null, 2)
    );
  } catch (_) { /* non-fatal */ }
}

// Upload endpoint — Presenton ~30-90s, TTS ~3-5x realtime on CPU.
// Default 10-min timeout. Set REQUEST_TIMEOUT_MS=... to override.
app.post('/api/upload', requireApiToken, upload.single('pdf'), async (req, res) => {
  req.setTimeout(TIMEOUT_MS);
  res.setTimeout(TIMEOUT_MS);

  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  const wantVoiceover = req.query.voiceover === '1' || req.body.voiceover === '1';

  // Optional per-request slide count (1-50). Overrides PPT_SLIDES from .env.
  const slidesParam = req.query.slides || req.body.slides;
  let slides;
  if (slidesParam !== undefined && slidesParam !== null && slidesParam !== '') {
    slides = parseInt(slidesParam, 10);
    if (!Number.isFinite(slides) || slides < 1 || slides > 50) {
      return res.status(400).json({ error: 'slides must be a number between 1 and 50' });
    }
  }

  const deckId = uuidv4();
  const deckDir = path.join(decksDir, deckId);

  try {
    console.log(`Processing PDF: ${req.file.originalname}${wantVoiceover ? ' (with voiceover)' : ''}${slides ? ` (${slides} slides)` : ''}`);
    const manifest = await runPipeline(req.file.path, deckId, {
      voiceover: wantVoiceover,
      slides,
    });

    // Clean up uploaded PDF
    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      deckId,
      manifest,
      downloadUrl: manifest.downloadUrl,
      downloadBytes: manifest.downloadBytes,
    });
  } catch (error) {
    console.error('Processing error:', error);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    if (fs.existsSync(deckDir)) fs.rmSync(deckDir, { recursive: true, force: true });
    res.status(500).json({
      error: error.message || 'Failed to process PDF',
    });
  }
});

// Async upload endpoint — returns immediately with a deckId; the pipeline
// runs in the background. Clients poll GET /api/decks/:deckId/status until
// it reports "completed" (manifest.json exists) or "failed".
app.post('/api/upload-async', requireApiToken, upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }

  const wantVoiceover = req.query.voiceover === '1' || req.body.voiceover === '1';

  const slidesParam = req.query.slides || req.body.slides;
  let slides;
  if (slidesParam !== undefined && slidesParam !== null && slidesParam !== '') {
    slides = parseInt(slidesParam, 10);
    if (!Number.isFinite(slides) || slides < 1 || slides > 50) {
      // Reject before queueing — clean up the uploaded file.
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'slides must be a number between 1 and 50' });
    }
  }

  const deckId = uuidv4();
  const pdfPath = req.file.path;
  writeDeckStatus(deckId, 'queued', { filename: req.file.originalname });

  // Respond immediately — the deck is now owned by the background task.
  res.status(202).json({
    success: true,
    deckId,
    status: 'queued',
    pollUrl: `/api/decks/${deckId}/status`,
  });

  // Background processing. Not awaited so the response returns instantly.
  // The single-threaded event loop means only one deck is actually
  // processed at a time; extra queued jobs wait their turn naturally.
  (async () => {
    try {
      writeDeckStatus(deckId, 'processing', { filename: req.file.originalname });
      console.log(`[async] Processing PDF: ${req.file.originalname}${wantVoiceover ? ' (with voiceover)' : ''}${slides ? ` (${slides} slides)` : ''}`);
      const manifest = await runPipeline(pdfPath, deckId, {
        voiceover: wantVoiceover,
        slides,
      });
      fs.unlinkSync(pdfPath);
      writeDeckStatus(deckId, 'completed');
      console.log(`[async] Deck ready: ${deckId}`);
    } catch (error) {
      console.error(`[async] Processing error for ${deckId}:`, error);
      if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
      writeDeckStatus(deckId, 'failed', { error: error.message || 'Failed to process PDF' });
    }
  })();
});

// Deck processing status — for async clients.
app.get('/api/decks/:deckId/status', (req, res) => {
  const deckId = req.params.deckId;
  const deckDir = path.join(decksDir, deckId);
  if (!fs.existsSync(deckDir)) {
    return res.status(404).json({ error: 'Deck not found' });
  }
  // Completed decks have a manifest.json; otherwise read status.json.
  const manifestPath = path.join(deckDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    return res.json({ deckId, status: 'completed' });
  }
  const statusPath = path.join(deckDir, 'status.json');
  if (fs.existsSync(statusPath)) {
    let status;
    try { status = JSON.parse(fs.readFileSync(statusPath, 'utf-8')); } catch (_) { status = {}; }
    return res.json({ deckId, status: status.status || 'processing', error: status.error || null, filename: status.filename || null });
  }
  res.json({ deckId, status: 'queued' });
});

// Get deck manifest
app.get('/api/decks/:deckId/manifest', (req, res) => {
  const manifestPath = path.join(decksDir, req.params.deckId, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return res.status(404).json({ error: 'Deck not found' });
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  res.json(manifest);
});

// List all generated decks (id, title, slide count, generatedAt, sizes).
app.get('/api/decks', (req, res) => {
  const list = [];
  let entries;
  try {
    entries = fs.readdirSync(decksDir, { withFileTypes: true });
  } catch (e) {
    return res.json({ decks: [] });
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const deckDir = path.join(decksDir, ent.name);
    let manifest = null;
    try {
      const manifestPath = path.join(deckDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (_) { /* ignore malformed */ }
    const size = (() => {
      try {
        return fs.readdirSync(deckDir)
          .map((f) => fs.statSync(path.join(deckDir, f)).size)
          .reduce((a, b) => a + b, 0);
      } catch (_) { return 0; }
    })();
    list.push({
      deckId: ent.name,
      title: (manifest && manifest.title) || ent.name,
      slideCount: (manifest && manifest.slideCount) || 0,
      generatedAt: (manifest && manifest.generatedAt) || null,
      hasVoiceover: !!(manifest && manifest.voiceoverUrl),
      viewerUrl: (manifest && manifest.viewerUrl) || `/decks/${ent.name}/view`,
      sizeBytes: size,
    });
  }
  list.sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
  res.json({ decks: list });
});

// Delete a deck (rm -rf the deck directory).
app.delete('/api/decks/:deckId', requireApiToken, (req, res) => {
  const deckId = req.params.deckId;
  // Basic path safety: only allow UUID-ish names to avoid path traversal.
  if (!/^[0-9a-fA-F-]{8,64}$/.test(deckId)) {
    return res.status(400).json({ error: 'Invalid deck id' });
  }
  const deckDir = path.join(decksDir, deckId);
  if (!fs.existsSync(deckDir)) {
    return res.status(404).json({ error: 'Deck not found' });
  }
  fs.rmSync(deckDir, { recursive: true, force: true });
  res.json({ success: true, deleted: deckId });
});

// Embed API: accepts slide content + voiceover preferences, generates the
// presentation, and returns an iframe-compatible embed code for full slide
// rendering with playback controls.
//   POST /api/embed
//   Body: {
//     content: string | string[],     // required — slide text or generation prompt
//     voiceover: boolean,             // optional — generate narration audio
//     voice: string,                  // optional — override TTS_VOICE for this request
//     slides: number,                 // optional — target slide count (string input only)
//     template: string,               // optional — Presenton template name
//     tone: string,                   // optional — Presenton tone
//     language: string,               // optional — Presenton language
//     autoplay: boolean               // optional — start playback when iframe loads
//   }
app.post('/api/embed', requireApiToken, async (req, res) => {
  req.setTimeout(TIMEOUT_MS);
  res.setTimeout(TIMEOUT_MS);

  const { content, voiceover, voice, slides, template, tone, language, autoplay } = req.body || {};
  if (!content || (Array.isArray(content) ? content.length === 0 : !String(content).trim())) {
    return res.status(400).json({ error: 'content is required' });
  }

  // Validate slide count (1-50) when provided.
  if (slides !== undefined && slides !== null && slides !== '') {
    const n = parseInt(slides, 10);
    if (!Number.isFinite(n) || n < 1 || n > 50) {
      return res.status(400).json({ error: 'slides must be a number between 1 and 50' });
    }
  }

  if (!embedOriginAllowed(req)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const deckId = uuidv4();
  const deckDir = path.join(decksDir, deckId);

  try {
    fs.mkdirSync(deckDir, { recursive: true });

    // Allow per-request override of the global TTS voice; restore afterward.
    const prev = {};
    if (voice) {
      prev.TTS_VOICE = process.env.TTS_VOICE;
      process.env.TTS_VOICE = String(voice);
    }

    console.log(`Processing embed content (${Array.isArray(content) ? content.length + ' slides' : String(content).length + ' chars'}${voiceover ? ', with voiceover' : ''})`);
    const manifest = await processContent(content, deckDir, {
      voiceover: voiceover === true || voiceover === '1',
      slides,
      template,
      tone,
      language,
    });

    if (voice) process.env.TTS_VOICE = prev.TTS_VOICE;

    const origin = `${req.protocol}://${req.get('host')}`;
    const query = `embed=1${autoplay ? '&autoplay=1' : ''}`;
    const iframeSrc = `${origin}/decks/${deckId}/view?${query}`;
    const embedCode =
      `<iframe src="${iframeSrc}" width="960" height="540" frameborder="0" ` +
      `allow="autoplay; fullscreen" allowfullscreen></iframe>`;

    res.json({
      success: true,
      deckId,
      iframeSrc,
      embedCode,
      viewerUrl: manifest.viewerUrl || `/decks/${deckId}/view`,
      manifest,
    });
  } catch (e) {
    console.error('Embed processing error:', e);
    if (voice) process.env.TTS_VOICE = prev.TTS_VOICE;
    if (fs.existsSync(deckDir)) fs.rmSync(deckDir, { recursive: true, force: true });
    res.status(500).json({ error: e.message || 'Failed to generate presentation' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`PDF to Slides server running at http://localhost:${PORT}`);
  console.log(`Request timeout: ${TIMEOUT_MS}ms (set REQUEST_TIMEOUT_MS to override)`);
});
