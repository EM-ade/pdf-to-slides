# Implementation Document: PDF-to-Slides — Full System

**Date:** August 28, 2026  
**Author:** Kilo (AI-assisted)  
**Version:** 1.0.0  
**Repository:** `pdf-to-slides`

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Services & Infrastructure](#3-services--infrastructure)
4. [Core Pipeline (`pipeline.js`)](#4-core-pipeline-pipelinejs)
5. [TTS & Voiceover Generation](#5-tts--voiceover-generation)
6. [Narration Tone Rewrite (LLM)](#6-narration-tone-rewrite-llm)
7. [Pixel-Perfect Slide Rendering](#7-pixel-perfect-slide-rendering)
8. [Browser Viewer (`viewer.html`)](#8-browser-viewer-viewerhtml)
9. [Server (`server.js`)](#9-server-serverjs)
10. [Frontend Upload UI (`index.html`)](#10-frontend-upload-ui-indexhtml)
11. [Configuration & Environment Variables](#11-configuration--environment-variables)
12. [Docker Compose Setup](#12-docker-compose-setup)
13. [Testing & Verification](#13-testing--verification)
14. [Known Limitations](#14-known-limitations)
15. [Future Improvements](#15-future-improvements)

---

## 1. Executive Summary

A web application that converts PDF documents into editable PowerPoint presentations with optional synchronized voiceover narration and an in-browser slide viewer.

**User workflow:**
1. Upload a PDF via the browser UI (drag-and-drop or file picker)
2. Backend sends it to Presenton (AI presentation generator) which produces a `.pptx`
3. (Optional) TTS generates per-slide voiceover narration
4. (Optional) LibreOffice renders each slide to a pixel-perfect PNG
5. Output: downloadable `.pptx`, `.zip` (slides + audio), or browser-based synchronized playback

**Key capabilities:**
- PDF → editable PowerPoint via Presenton + Gemini LLM
- OpenAI TTS voiceover (~15s for 10 slides, ~$0.045/deck)
- Per-slide voiceover timing for audio-synced browser playback
- Headless LibreOffice rendering for pixel-perfect slide images
- LLM-based narration rewrite (teacher tone → student-facing)
- LLM-based on-screen text polish (capitalization, punctuation)
- Presentation-mode viewer with keyboard controls, fullscreen, autoplay toggle

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        User's Browser                        │
│  http://localhost:3005                                       │
│  ┌────────────────┐  ┌──────────────────────────────────┐   │
│  │  Upload UI     │  │  Viewer (/decks/<id>/view)       │   │
│  │  (index.html)  │  │  (viewer.html)                   │   │
│  └───────┬────────┘  └──────────┬───────────────────────┘   │
└──────────┼───────────────────────┼───────────────────────────┘
           │ POST /api/upload      │ GET render.json, PNGs, audio
           v                       v
┌──────────────────────────────────────────────────────────────┐
│                 Node/Express App (server.js)                 │
│  Port 3005                                                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  pipeline.js                                           │ │
│  │  1. Upload PDF to Presenton                            │ │
│  │  2. Generate presentation (pptx)                       │ │
│  │  3. Fetch speaker notes from Presenton                 │ │
│  │  4. (Optional) Rewrite notes via LLM → student tone    │ │
│  │  5. Generate TTS voiceover (OpenAI or Kokoro)          │ │
│  │  6. (Optional) Render slides via LibreOffice → PNGs    │ │
│  │  7. (Optional) Polish slide text via LLM               │ │
│  │  8. Write manifest.json + render.json                  │ │
│  └────────────────────────────────────────────────────────┘ │
└──────┬────────────┬──────────────────┬──────────────────────┘
       │            │                  │
       v            v                  v
┌────────────┐ ┌──────────┐ ┌──────────────────────┐
│ Presenton  │ │ OpenAI   │ │ LibreOffice Renderer │
│ Container  │ │ TTS API  │ │ Docker Image         │
│ :5001      │ │ (cloud)  │ │ (pdf2slides-renderer) │
│ Gemini LLM │ └──────────┘ └──────────────────────┘
│ Pexels API │
└────────────┘
       │
       v
┌────────────┐
│ app_data/  │
│ shared vol │
└────────────┘
```

---

## 3. Services & Infrastructure

### 3.1 Presenton (Slide Generator)

- **Image:** `ghcr.io/presenton/presenton:latest`
- **Port:** 5001 → 80
- **Role:** AI-powered presentation generator. Accepts a PDF + generation parameters, produces a `.pptx` with slides, images, and speaker notes.
- **LLM backend:** Command Code (custom provider API) using `minimax/minimax-m3-free`
- **Image provider:** Pexels (API key required)
- **Data volume:** `./app_data` mounted at `/app_data`
- **Config:** `DISABLE_AUTH=true`, custom LLM/model, Pexels key

### 3.2 Node/Express App

- **File:** `Dockerfile` (7 lines), builds from `node:24-alpine`
- **Port:** 3005
- **Role:** Web server, API endpoints, pipeline orchestration
- **Key files:** `server.js` (121 lines), `pipeline.js` (925 lines)

### 3.3 LibreOffice Renderer

- **Files:** `renderer/Dockerfile` (21 lines), `renderer/render.sh` (31 lines)
- **Base:** `ubuntu:24.04` with `libreoffice-impress` + `poppler-utils` + fonts
- **Image:** `pdf2slides-renderer:latest` (~800MB)
- **Role:** One-shot conversions invoked via `docker run --rm`. Converts `.pptx` → PDF → per-slide PNGs (150dpi, 16:9).
- **Not a long-running service:** called on-demand per deck by the pipeline

### 3.4 Kokoro TTS (Optional, Self-Hosted)

- **Image:** `ghcr.io/remsky/kokoro-fastapi-cpu:latest`
- **Port:** 8880
- **Role:** Local text-to-speech. CPU-only, ~11 min for 10 slides.
- **Status:** Commented out in `docker-compose.yml` (default is OpenAI cloud TTS)

### 3.5 OpenAI TTS (Default)

- **Endpoint:** `https://api.openai.com/v1/audio/speech`
- **Model:** `tts-1` (fast) or `tts-1-hd`
- **Voice:** `nova` (warm female)
- **Latency:** ~10-15 seconds for 10 slides
- **Cost:** ~$0.045/deck ($15/1M characters)
- **Requires:** `OPENAI_API_KEY` in `.env`

---

## 4. Core Pipeline (`pipeline.js`)

**925 lines.** The main orchestrator. Single export: `processPDF(pdfPath, deckDir, options)`.

### 4.1 Pipeline Steps

```
[1/4] Upload PDF to Presenton
        → POST /api/v1/ppt/files/upload (multipart)
        → Returns file_id or remote path

[2/4] Generate presentation
        → POST /api/v1/ppt/presentation/generate (JSON body)
        → Params: content, files, n_slides, template, tone, verbosity, language
        → Returns presentationId
        → Retry: 3 attempts with 4s/8s backoff on 500/503

[3/4] Fetch .pptx into deck folder
        → Downloads from Presenton (via resolvePresentonPath → local or remote)
        → Writes decks/<uuid>/deck.pptx
        → Downloads any referenced images (Pexels) to same folder
        → Zips everything into deck.zip

[4/5] Generate voiceover (if enabled)
        → fetchSlides(presentationId) → speaker notes
        → (Optional) rewriteNarrationForStudents() → LLM rewrites for student tone
        → generateVoiceover() → per-slide TTS → concat with 600ms silence gaps
        → Probes per-segment durations → slideTimings array
        → Writes decks/<uuid>/voiceover.mp3

[5/5] Extract slide render data
        → (If USE_RENDERER=1) renderSlidesViaLibreOffice() → PNGs
        → (Else) extractSlideRenderData() → composited JSON
        → (Optional) rewriteSlidesForClarity() → LLM polish
        → Writes decks/<uuid>/render.json
```

### 4.2 Key Functions

| Function | Lines | Purpose |
|---|---|---|
| `processPDF()` | ~160 | Main pipeline orchestrator |
| `postMultipart()` | ~45 | HTTP multipart upload to Presenton |
| `getJson()` | ~35 | HTTP GET with JSON parse |
| `downloadToFile()` | ~35 | Download URL to file (with redirects) |
| `resolvePresentonPath()` | ~15 | Local ↔ remote path resolution |
| `fetchSlides()` | ~15 | GET speaker notes from Presenton API |
| `rewriteNarrationForStudents()` | ~90 | LLM rewrite: teacher → student tone |
| `rewriteSlidesForClarity()` | ~120 | LLM rewrite: fix text formatting |
| `generateVoiceover()` | ~110 | Per-slide TTS with parallel worker pool |
| `extractSlideRenderData()` | ~90 | PPTX → render spec (text + images) |
| `renderSlidesViaLibreOffice()` | ~50 | Shell out to docker for PNG rendering |
| `parseRels()` | ~10 | Parse PPTX relationship files |
| `parseSlideItems()` | ~50 | Parse slide XML → positioned items |
| `collectText()` | ~20 | Extract text from PPTX shapes |
| `joinRuns()` | ~20 | Fix run-joining artifacts |
| `probeAudioDurationSeconds()` | ~8 | ffmpeg duration probe |

### 4.3 PPTX Text Extraction

The `extractSlideRenderData` function uses `jszip` to unzip the PPTX, then parses:
- `ppt/slides/slideN.xml` — per-slide content
- `ppt/slides/_rels/slideN.xml.rels` — media references
- `ppt/media/*.{png,svg,jpg}` — embedded images

**XML parsing is regex-based** (no DOM parser required). Extracts:
- Background color (`<a:srgbClr>` inside `<p:bg>`)
- Image positions (`<p:pic>` with `<a:off>`, `<a:ext>`, `r:embed`)
- Text positions + formatting (`<p:sp>` with `<a:off>`, `<a:ext>`, `<a:rPr>` for size/color/bold, `<a:pPr>` for alignment)

**Output:** An array of `{ type, x, y, w, h, ... }` items per slide, in PPTX EMU units (1 inch = 914400 EMU, slide = 12192000 × 6858000).

### 4.4 Run-Joining Fix

Presenton/LibreOffice sometimes emits adjacent text runs with no separator (e.g., "authorization" + "intent" → "authorizationintent"). The `joinRuns` function inserts a space between two non-empty runs when neither side already has whitespace or punctuation at the boundary.

---

## 5. TTS & Voiceover Generation

### 5.1 Architecture

```
Speaker Notes (from Presenton)
    ↓
(Optional) LLM Rewrite → student-facing text
    ↓
TTS API (OpenAI or Kokoro) → per-slide MP3 segments
    ↓
Probed per-segment durations
    ↓
FFmpeg concat with 600ms silence gaps → voiceover.mp3
    ↓
slideTimings = [{ index: 0, start: 0, end: 23.4 }, ...]
```

### 5.2 Parallel TTS Worker Pool

```javascript
const TTS_CONCURRENCY = Math.max(1, parseInt(process.env.TTS_CONCURRENCY || '6', 10));
const queue = slides.map((_, i) => i);
const workers = Array.from({ length: Math.min(TTS_CONCURRENCY, slides.length) }, async () => {
    while (queue.length) {
        const i = queue.shift();
        const buf = await ttsWithRetry(text);
        fs.writeFileSync(segPath, buf);
        segPaths[i] = segPath;
    }
});
await Promise.all(workers);
```

- **OpenAI:** Handles parallelism natively; concurrency 6 works fine.
- **Kokoro CPU:** Serializes internally; concurrency 4 is the practical ceiling.
- Each segment gets a 2-attempt retry with 1.5s delay.
- Timeout: 5 minutes per TTS request.

### 5.3 Slide Timings

After all segments are generated, the pipeline probes each `_seg_NN.mp3` duration with `ffmpeg -i ... -f null -` (reads the `Duration:` line from stderr). Cumulative start/end times are computed:

```json
[
  { "index": 0, "start": 0, "end": 23.4 },
  { "index": 1, "start": 24.0, "end": 51.2 },
  ...
]
```

The 600ms silence gap between segments is attributed to the following slide, so the slide changes just before narration begins.

### 5.4 FFmpeg Concat

```bash
ffmpeg -f concat -safe 0 -i _concat.txt -c copy -y voiceover.mp3
```

The concat list interleaves per-slide segments with a 600ms silent MP3 (`anullsrc=channel_layout=mono:sample_rate=24000`).

---

## 6. Narration Tone Rewrite (LLM)

### 6.1 Problem

Presenton's speaker notes are written for a teacher presenting to students:
> "This slide outlines the key learning objectives. We will cover hacking fundamentals..."

The TTS reads this verbatim — the voice says "we will cover" instead of directly addressing the student.

### 6.2 Solution: `rewriteNarrationForStudents()`

**Flag:** `NARRATION_REWRITE=1` in `.env`

Uses the same Command Code LLM (custom provider API) to batch-rewrite all slide notes in a single LLM call (~11s for 3 slides, ~30-40s for 10 slides).

**System prompt rules:**
- Address the student as "you" ("Today you'll learn...", "Notice how...", "Try to think about why...")
- Never use teacher-facing language: no "This slide outlines...", "The presenter should...", "We will cover..."
- Keep the same length and ideas; 1-3 sentences per slide
- Sound like a calm, friendly tutor talking one-on-one to a 12-17 year old

**Before/After:**

| Slide | Before (raw) | After (rewritten) |
|---|---|---|
| 1 | "This is the opening slide for our session on Ethical Hacking..." | "Welcome to your guide on ethical hacking and cybersecurity..." |
| 2 | "This slide outlines our learning agenda for today..." | "Here's what you'll be learning today. You'll start with the core ideas..." |
| 3 | "This slide outlines the key learning objectives..." | "By the end of this, you'll have a clear roadmap of what to master..." |

---

## 7. Pixel-Perfect Slide Rendering

### 7.1 Problem

The original text-composited viewer parsed PPTX XML and positioned HTML `<div>`s. This missed slide masters, gradients, complex shapes, and produced stripped-down views.

### 7.2 Solution: Headless LibreOffice

**Flag:** `USE_RENDERER=1` in `.env`

**Build:** `npm run build:renderer` (one-time, ~800MB Docker image)

**Flow:**
```
deck.pptx → docker run → libreoffice --headless --convert-to pdf → pdftoppm -png -r 150 → slide-01.png ... slide-N.png
```

**Image specs:**
- Resolution: 2001×1125 px (150dpi, 16:9)
- Output: `decks/<id>/slides/slide-01.png` through `slide-10.png`
- File sizes: 100KB–1.5MB per slide depending on content

### 7.3 Renderer Docker Image

```dockerfile
FROM ubuntu:24.04
RUN apt-get install libreoffice-impress poppler-utils fonts-liberation fonts-noto ...
COPY render.sh /usr/local/bin/render
ENTRYPOINT ["render"]
```

**`render.sh`:**
1. Copies the PPTX into a temp directory
2. `libreoffice --headless --convert-to pdf --outdir <work> <work>/input.pptx`
3. `pdftoppm -png -r 150 <work>/input.pdf <work>/slide`
4. Renames to zero-padded `slide-01.png` format
5. Cleans up temp files

### 7.4 Integration

The Node pipeline calls:
```javascript
const r = spawnSync('docker', [
    'run', '--rm',
    '-v', `${mountsDir}:/work`,
    'pdf2slides-renderer:latest',
    `/work/${deckName}/${pptxName}`, `/work/${deckName}/slides`, '150',
], { stdio: 'pipe', timeout: 120000 });
```

**Fallback:** If the renderer image isn't built or docker isn't available, the pipeline falls back to text-composited rendering automatically.

---

## 8. Browser Viewer (`viewer.html`)

**606 lines.** Self-contained HTML/CSS/JS, no build step.

### 8.1 Two Rendering Modes

**Raster mode** (`render.json` mode: `"raster"`):
```javascript
for (const s of render.slides) {
    const img = document.createElement('img');
    img.src = `/decks/${deckId}/${s.src}`;
    img.style.objectFit = 'contain';
    slideEl.appendChild(img);
}
```
One `<img>` per slide. Pixel-perfect. No positioning logic.

**Composited mode** (`render.json` mode: `"composited"`):
```javascript
// Position text+images from parsed PPTX data
el.style.left = (it.x / slideW * 100) + '%';
el.style.fontSize = `min(${(it.fontSize / 72) * 13.33}vw, ${it.fontSize * 1.4}px)`;
el.textContent = it.text;
```
Text boxes positioned as `<div>`s with vw-based font sizing. SVGs inlined for proper scaling. Fallback when LibreOffice renderer is unavailable.

### 8.2 Audio-Slide Sync

```javascript
audio.addEventListener('timeupdate', () => {
    const t = audio.currentTime;
    showSlide(findSlideIndex(t));
});

function findSlideIndex(t) {
    for (let i = 0; i < timings.length; i++) {
        if (t >= timings[i].start && t < timings[i].end) return i;
    }
}
```

The `timings` array is loaded from `manifest.json`'s `slideTimings` field. Each entry defines the start/end time of when that slide should be visible.

### 8.3 Viewing Modes

**Presentation mode** (default):
- Canvas fills entire viewport (`100vw × 100vh`)
- No top bar, no controls
- Floating "⚙ Controls" button in top-right
- Pill hint shows keyboard shortcuts, fades after 4s
- Click canvas to play/pause

**Editor mode**:
- Top bar (title + download links)
- Bottom controls (play/pause, restart, prev/next, scrubber, slide counter)
- Toggle via "C" key or "⚙ Controls" button

### 8.4 Autoplay Overlay

On load, a radial-gradient overlay with:
- Deck title + slide count + total duration
- Large circular ▶ play button (browser requires user gesture for audio)
- "☐ Autoplay next time" checkbox (persisted in `localStorage`)

### 8.5 Keyboard Controls

| Key | Action |
|---|---|
| Space | Play/pause |
| ← | Previous slide (or restart current if >0.3s into it) |
| → | Next slide |
| R | Restart from beginning |
| C | Toggle presentation ↔ editor mode |
| F | Toggle browser fullscreen |

### 8.6 Visual Design

- Dark background (#000) with white canvas
- Crossfade transition between slides (280ms opacity)
- Autoplay overlay uses `backdrop-filter: blur(8px)`
- Scrubber uses accent color `#4ea8ff`
- All controls use rounded corners + dark semi-transparent backgrounds

---

## 9. Server (`server.js`)

**121 lines.** Minimal Express server.

### 9.1 Routes

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Serve `public/index.html` (upload UI) |
| `/decks/<id>/view` | GET | Serve `viewer.html` (or redirect to pptx) |
| `/api/upload` | POST | PDF upload + pipeline execution |
| `/api/health` | GET | Health check |
| `/decks/*` | GET | Static file serving (pptx, mp3, pngs, render.json, manifest.json) |
| `/api/decks/<id>/manifest` | GET | Serve manifest.json for the viewer |

### 9.2 Upload Handler

```javascript
app.post('/api/upload', upload.single('pdf'), async (req, res) => {
    req.setTimeout(TIMEOUT_MS); // default 600000ms (10 min)
    const deckDir = path.join(decksDir, uuidv4());
    fs.mkdirSync(deckDir, { recursive: true });
    const manifest = await processPDF(req.file.path, deckDir, {
        voiceover: req.query.voiceover === '1',
    });
    // ... zip, send response
});
```

- **Multer** handles the upload (50MB limit, PDF-only filter)
- **UUID** generates the deck directory name
- **Timeout:** 10 minutes (configurable via `REQUEST_TIMEOUT_MS`)
- **Response:** `{ downloadUrl, downloadBytes, manifest: { ... } }`

### 9.3 Viewer Route

```javascript
app.get('/decks/:deckId/view', (req, res) => {
    const renderPath = path.join(deckDir, 'render.json');
    if (!fs.existsSync(renderPath)) {
        return res.redirect(`/decks/${req.params.deckId}/deck.pptx`);
    }
    res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});
```

Redirects to the .pptx download if no render.json exists (i.e., no voiceover was generated).

---

## 10. Frontend Upload UI (`index.html`)

**279 lines.** Clean, dark-themed upload interface.

### 10.1 Features

- **Drag-and-drop zone** with visual feedback (dashed border → solid on dragover)
- **File picker** fallback via hidden `<input type="file">`
- **Voiceover checkbox** (checked by default): `Add voiceover narration (OpenAI TTS, ~15s for 10 slides)`
- **Progress indicator** during upload (shows estimated time)
- **Success state:** Download button + "▶ Play in browser" button (green, appears when voiceover is on)
- **Error handling:** Red status message + re-enabled upload button

### 10.2 Progress Display

```javascript
const deckText = wantVoiceover
    ? `Uploading to Presenton, generating slides, then voiceover (30–90s + ~15s TTS)...`
    : `Uploading to Presenton and generating your deck (30–90s)...`;
```

### 10.3 Success State

```javascript
viewBtn.textContent = wantVoiceover ? 'Download .zip (slides + audio)' : 'Download .pptx';
if (wantVoiceover && m.viewerUrl) {
    playBtn.href = m.viewerUrl;
    playBtn.style.display = 'block';
}
```

---

## 11. Configuration & Environment Variables

### 11.1 Full .env.example

```env
# Presenton API
PRESENTON_URL=http://localhost:5001
CUSTOM_LLM_URL="https://api.commandcode.ai/provider/v1"
CUSTOM_LLM_API_KEY=your-key-here
CUSTOM_MODEL=minimax/minimax-m3-free
PEXELS_API_KEY=your-key-here

# TTS (OpenAI default)
TTS_URL=https://api.openai.com/v1/audio/speech
TTS_VOICE=nova
TTS_MODEL=tts-1
OPENAI_API_KEY=sk-your-openai-key-here
TTS_CONCURRENCY=6

# Presentation settings
PPT_TEMPLATE=general
PPT_SLIDES=10
PPT_TONE=educational
PPT_LANGUAGE=English
PPT_VERBOSITY=standard
PPT_INCLUDE_TITLE=true
PPT_INCLUDE_TOC=false

# Pipeline features
NARRATION_REWRITE=0
SLIDES_REWRITE=0
USE_RENDERER=1

# Server
PORT=3005
REQUEST_TIMEOUT_MS=600000
```

### 11.2 Feature Flags

| Flag | Default | Purpose |
|---|---|---|
| `NARRATION_REWRITE` | `0` | LLM rewrite of speaker notes for student-facing narration |
| `SLIDES_REWRITE` | `0` | LLM polish of on-screen text (capitalization, punctuation) |
| `USE_RENDERER` | `1` | LibreOffice rendering of slides to PNGs |
| `TTS_CONCURRENCY` | `6` | Parallel TTS requests during voiceover generation |

### 11.3 TTS Provider Switching

| Provider | `TTS_URL` | Auth | Latency | Cost |
|---|---|---|---|---|
| OpenAI (default) | `https://api.openai.com/v1/audio/speech` | `OPENAI_API_KEY` | ~15s | ~$0.045/deck |
| Kokoro CPU (local) | `http://localhost:8880/v1/audio/speech` | None | ~11 min | Free |
| Kokoro GPU (local) | `http://localhost:8880/v1/audio/speech` | None | ~40s | Free |
| Any OpenAI-compatible | any URL | `OPENAI_API_KEY` | varies | varies |

### 11.4 Presenton Templates

| Template | Style | Recommendation |
|---|---|---|
| `general` | Corporate, gradient banners, icon grids | Default; busy for educational content |
| `minimal` | Clean, whitespace-heavy | Best for viewer rendering |
| `modern` | Bold typography, dark backgrounds | Good for tech topics |
| `professional` | Corporate, blue accents | Business decks |
| `creative` | Playful, illustrations | Non-technical topics |
| `editorial` | Magazine-style | Long-form content |
| `dynamic` | Most decorative | Marketing |
| `elegant` | Serif typography | Formal presentations |

---

## 12. Docker Compose Setup

### 12.1 Full `docker-compose.yml`

```yaml
version: '3.8'
services:
  presenton:
    image: ghcr.io/presenton/presenton:latest
    ports: ["5001:80"]
    environment:
      - LLM=custom
      - CUSTOM_LLM_URL="https://api.commandcode.ai/provider/v1"
      - CUSTOM_LLM_API_KEY=${CUSTOM_LLM_API_KEY}
      - CUSTOM_MODEL=minimax/minimax-m3-free
      - IMAGE_PROVIDER=pexels
      - PEXELS_API_KEY=${PEXELS_API_KEY}
      - CAN_CHANGE_KEYS=false
      - DISABLE_AUTH=true
    volumes: ["./app_data:/app_data"]

  app:
    build: .
    ports: ["3005:3005"]
    environment:
      - PRESENTON_URL=http://presenton:5001
      - TTS_URL=${TTS_URL:-https://api.openai.com/v1/audio/speech}
      - TTS_VOICE=${TTS_VOICE:-nova}
      - TTS_MODEL=${TTS_MODEL:-tts-1}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    depends_on: [presenton]
    volumes: ["./app_data:/app_data"]

  renderer:
    build: ./renderer
    image: pdf2slides-renderer:latest
    command: ["true"]
    profiles: ["build-only"]
    restart: "no"
```

### 12.2 Docker Image Sizes

| Image | Size | Purpose |
|---|---|---|
| `presenton` | ~2GB | AI slide generator |
| `app` | ~150MB | Node.js server |
| `renderer` | ~800MB | LibreOffice headless |
| **Total** | **~3GB** | |

---

## 13. Testing & Verification

### 13.1 End-to-End Test (Existing Deck)

**Deck:** `699615aa-c0b8-44ac-a2b1-8c41718e311b` (10 slides, Ethical Hacking for Young Defenders)

**Test flow:**
1. PDF uploaded → Presenton generated deck in ~5 min
2. OpenAI TTS generated voiceover in ~15s
3. LibreOffice rendered 10 PNGs in ~30s
4. Manifest + render.json written

**Results:**
- `deck.pptx`: 2.3 MB (editable PowerPoint)
- `deck.zip`: 5.3 MB (pptx + audio bundle)
- `voiceover.mp3`: 3.1 MB (4:16 total duration)
- `slides/`: 10 PNGs, 100KB–1.5MB each
- `render.json`: 36KB (raster mode, 2001×1125 px)
- `manifest.json`: 1.5KB (timings, metadata)

### 13.2 TTS Rewrite Verification

Tested `rewriteNarrationForStudents()` against the real Command Code API:
- **Latency:** 11.5s for 3 slides
- **Quality:** Successfully converts teacher-tone to student-facing narration
- **Content preservation:** Same ideas, similar length, correct facts

### 13.3 LibreOffice Rendering Verification

- **Dimension accuracy:** 2001×1125 px (correct 16:9 at 150dpi)
- **Visual fidelity:** Pixel-identical to PowerPoint output
- **Font support:** Liberation + Noto fonts substitute Calibri/Arial correctly
- **Chinese/CJK:** Supported via `fonts-noto-cjk`

### 13.4 Run-Joining Bug Fix

**Bug:** "authorization" + "intent" → "authorizationintent" (no space)
**Root cause:** Presenton emits empty text runs between formatting-change markers; `joinRuns()` now inserts a space between adjacent non-empty runs.

**Verified:** Slide 4 now correctly shows "authorization intent. White Hats are hired professionals..."

---

## 14. Known Limitations

### 14.1 Rendering

- **Raster mode only available if `npm run build:renderer` was run** (~800MB one-time build)
- **Text not selectable** in raster mode (PNGs, not text layers)
- **CJK fonts** may not cover all Asian characters without explicit font installation
- **Animations/transitions** not captured (static PNG per slide)

### 14.2 Viewer

- **Audio autoplay** requires user gesture (browser security policy); overlay with play button is the workaround
- **No word-level highlighting** (would require WhisperX forced alignment on concatenated audio)
- **Slide change at segment boundaries only** — no mid-slide transitions based on audio content
- **No slide thumbnails/scrubber preview** — just a numbered counter

### 14.3 TTS

- **OpenAI TTS** requires API key and $5 free credit (or paid account)
- **Kokoro CPU** is ~11 min for 10 slides (only practical for batch/offline use)
- **Per-slide narration** only (no sentence-level timing within a slide)

### 14.4 Content

- **Presenton's slide content** is AI-generated; quality depends on the LLM + template chosen
- **Speaker notes** may be teacher-facing by default; `NARRATION_REWRITE=1` fixes this
- **On-screen text** may have capitalization/punctuation issues; `SLIDES_REWRITE=1` fixes this
- **Images** are sourced from Pexels; may not match the topic precisely

### 14.5 Pipeline

- **10-minute timeout** by default (`REQUEST_TIMEOUT_MS`); large PDFs with voiceover may exceed this
- **Presenton intermittently 500s** (LLM provider flake); handled with 3-retry backoff
- **No progress reporting** to the UI during generation (just a spinner)

---

## 15. Future Improvements

### 15.1 High Priority

1. **Lazy job submission** — return `jobId` immediately, poll for completion. Unblocks 30s proxies.
2. **Progress streaming** — SSE or WebSocket from pipeline to UI showing "Slide 3/10 generating..."
3. **Per-slide audio files** — save `slide-01.mp3` alongside `slide-01.png` for granular sync.
4. **Word-level highlighting** — WhisperX forced alignment on concatenated audio, overlay `<span>` per word.
5. **PDF hash caching** — reuse existing deck if the same PDF is re-uploaded.

### 15.2 Medium Priority

6. **`/api/regen-voiceover` endpoint** — regenerate audio without re-running Presenton.
7. **Slide layout rendering** — parse `ppt/slideLayouts/` for master decorations.
8. **Table rendering** (`<a:tbl>` — extract cell text and render as HTML tables).
9. **Multiple voice options** — per-deck or per-slide voice selection.
10. **Audio concatenation with ducking** — background music + voiceover mixing.

### 15.3 Low Priority

11. **Export as video** — use ffmpeg to combine slide PNGs + voiceover into MP4.
12. **Slide transition effects** — CSS fade/wipe animations between slides.
13. **Speaker notes display** — toggle a "presenter notes" panel in the viewer.
14. **Collaborative editing** — real-time slide editing via WebSocket.
15. **Slide templates** — user-selectable themes that change the render.json styling.

---

## Appendix A: File Inventory

```
pdf-to-slides/
├── pipeline.js              # 925 lines — core pipeline (TTS, PPTX parsing, rendering)
├── server.js                # 121 lines — Express server, routes, upload handler
├── Dockerfile               #   7 lines — Node.js app image
├── docker-compose.yml       #  59 lines — service definitions
├── package.json             #  20 lines — dependencies + scripts
├── .env.example             #  47 lines — all config documented
├── .gitignore               #       — excludes node_modules, .env, decks/
├── renderer/
│   ├── Dockerfile           #  21 lines — LibreOffice + Poppler image
│   └── render.sh            #  31 lines — pptx → PDF → PNGs script
├── public/
│   ├── index.html           # 279 lines — upload UI
│   └── viewer.html          # 606 lines — presentation viewer
├── decks/                   # generated — per-deck output
│   └── <uuid>/
│       ├── deck.pptx        # editable PowerPoint
│       ├── deck.zip         # bundled download
│       ├── manifest.json    # metadata, timings, viewer URL
│       ├── render.json      # slide render spec (raster or composited)
│       ├── voiceover.mp3    # concatenated narration
│       ├── media/           # extracted PPTX images (composited mode)
│       └── slides/          # rendered PNGs (raster mode)
├── app_data/                # shared volume with Presenton
└── uploads/                 # temporary PDF uploads
```

## Appendix B: API Reference

### POST /api/upload

**Query params:** `voiceover=1` (optional)

**Body:** `multipart/form-data` with field `pdf` (file, max 50MB, MIME `application/pdf`)

**Response (200):**
```json
{
  "downloadUrl": "/decks/<id>/deck.zip",
  "downloadBytes": 5258274,
  "manifest": {
    "deckId": "<uuid>",
    "title": "...",
    "slideCount": 10,
    "pptxUrl": "/decks/<id>/deck.pptx",
    "pptxBytes": 2287122,
    "presentationId": "<uuid>",
    "template": "general",
    "generatedAt": "2026-08-28T07:11:56.709Z",
    "voiceoverUrl": "/decks/<id>/voiceover.mp3",
    "voiceoverBytes": 3112437,
    "voiceoverSlides": 10,
    "slideTimings": [
      { "index": 0, "start": 0, "end": 23.4 },
      { "index": 1, "start": 24.0, "end": 51.2 }
    ],
    "viewerUrl": "/decks/<id>/view"
  }
}
```

### GET /decks/:id/view

Returns `viewer.html` if `render.json` exists; redirects to `.pptx` download otherwise.

### GET /decks/:id/render.json

**Raster mode:**
```json
{
  "mode": "raster",
  "slideW": 2001,
  "slideH": 1125,
  "slides": [
    { "index": 1, "src": "slides/slide-01.png" },
    { "index": 2, "src": "slides/slide-02.png" }
  ]
}
```

**Composited mode:**
```json
{
  "mode": "composited",
  "slideW": 12192000,
  "slideH": 6858000,
  "slides": [
    {
      "index": 1,
      "items": [
        { "type": "bg", "color": "#FFFFFF" },
        { "type": "text", "x": 6400800, "y": 1552575, "w": 5067300, "h": 914400,
          "text": "Ethical Hacking Guide", "fontSize": 45, "color": "#111827",
          "bold": true, "align": "left" },
        { "type": "image", "x": 838200, "y": 1981200, "w": 4876800, "h": 3048000,
          "src": "media/slide01_Presenton_Raster_Image_3.png" }
      ]
    }
  ]
}
```

### GET /api/decks/:id/manifest

Returns the manifest.json contents.

### GET /api/health

Returns `200 OK`.

---

*End of implementation document.*
