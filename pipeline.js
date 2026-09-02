const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const JSZip = require('jszip');

const SLIDE_W = 12192000;
const SLIDE_H = 6858000;

const PRESENTON_URL = (process.env.PRESENTON_URL || 'http://localhost:5001').replace(/\/+$/, '');
const TTS_URL = (process.env.TTS_URL || 'https://api.openai.com/v1/audio/speech').replace(/\/+$/, '');
const TTS_VOICE = process.env.TTS_VOICE || 'nova';
const TTS_MODEL = process.env.TTS_MODEL || 'tts-1';
const TTS_API_KEY = process.env.OPENAI_API_KEY || process.env.TTS_API_KEY || '';
const TTS_CONCURRENCY = Math.max(1, parseInt(process.env.TTS_CONCURRENCY || '6', 10));

const TEMPLATE = process.env.PPT_TEMPLATE || 'general';
const N_SLIDES = parseInt(process.env.PPT_SLIDES || '10', 10);
const TONE = process.env.PPT_TONE || 'educational';
const LANGUAGE = process.env.PPT_LANGUAGE || 'English';
const VERBOSITY = process.env.PPT_VERBOSITY || 'standard';
const INCLUDE_TITLE = (process.env.PPT_INCLUDE_TITLE || 'true').toLowerCase() !== 'false';
const INCLUDE_TOC = (process.env.PPT_INCLUDE_TOC || 'false').toLowerCase() === 'true';

function pickLib(parsedUrl) {
  return parsedUrl.protocol === 'http:' ? http : https;
}

function postMultipart(targetUrl, filePath, fieldName = 'file') {
  return new Promise((resolve, reject) => {
    const filename = path.basename(filePath);
    const boundary = '----presenton' + Math.random().toString(36).slice(2);
    const fileData = fs.readFileSync(filePath);

    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, fileData, tail]);

    const url = new URL(targetUrl);
    const lib = pickLib(url);
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + (url.search || ''),
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} from ${targetUrl}: ${chunks.slice(0, 500)}`));
          }
          try {
            resolve(JSON.parse(chunks));
          } catch (e) {
            reject(new Error(`Bad JSON from ${targetUrl}: ${e.message} body=${chunks.slice(0, 500)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function postJson(targetUrl, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const url = new URL(targetUrl);
    const lib = pickLib(url);
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + (url.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode} from ${targetUrl}: ${chunks.slice(0, 500)}`));
          }
          try {
            resolve(JSON.parse(chunks));
          } catch (e) {
            reject(new Error(`Bad JSON from ${targetUrl}: ${e.message} body=${chunks.slice(0, 500)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function getJson(targetUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const lib = pickLib(url);
    lib.get(targetUrl, (res) => {
      let chunks = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode} from ${targetUrl}: ${chunks.slice(0, 500)}`));
        }
        try {
          resolve(JSON.parse(chunks));
        } catch (e) {
          reject(new Error(`Bad JSON from ${targetUrl}: ${e.message} body=${chunks.slice(0, 500)}`));
        }
      });
    }).on('error', reject);
  });
}

function postRawAudio(targetUrl, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const url = new URL(targetUrl);
    const lib = pickLib(url);
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + (url.search || ''),
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let err = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (err += c));
          res.on('end', () => reject(new Error(`Kokoro HTTP ${res.statusCode}: ${err.slice(0, 300)}`)));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Copy a file. Used to move the .pptx from the shared app_data volume
// into our decks/ folder so Express can serve it as a static file.
function copyFile(src, dest) {
  return new Promise((resolve, reject) => {
    const rd = fs.createReadStream(src);
    const wr = fs.createWriteStream(dest);
    rd.on('error', reject);
    wr.on('error', reject);
    wr.on('finish', () => resolve(dest));
    rd.pipe(wr);
  });
}

// Download a URL to a local file via streaming GET (handles redirects).
// Used to fetch the generated .pptx from Presenton's /app_data endpoint.
function downloadToFile(targetUrl, destPath, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    function fetchOnce(u, redirectsLeft) {
      const url = new URL(u);
      const lib = pickLib(url);
      lib.get(u, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          const next = res.headers.location;
          if (!next) return reject(new Error('Redirect without Location'));
          const absolute = new URL(next, u).toString();
          res.resume();
          return fetchOnce(absolute, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => reject(new Error(`Download failed: HTTP ${res.statusCode} from ${u}: ${body.slice(0, 300)}`)));
          return;
        }
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(destPath)));
        file.on('error', reject);
      }).on('error', reject);
    }
    fetchOnce(targetUrl, maxRedirects);
  });
}

function resolvePresentonPath(remotePath) {
  // Presenton paths look like /app_data/<uuid>/<title>.pptx
  // We mount ./app_data into the Presenton container, so the same file is
  // available locally at <project>/app_data/<uuid>/<title>.pptx.
  // We resolve relative to the project root (process.cwd()) since the
  // Express server is started from there.
  if (!remotePath) return null;
  const cleaned = remotePath.replace(/^\/+/, '');
  return path.join(process.cwd(), cleaned);
}

async function fetchSlides(presentationId) {
  if (!presentationId) throw new Error('fetchSlides: missing presentationId');
  const url = `${PRESENTON_URL}/api/v1/ppt/presentation/${encodeURIComponent(presentationId)}`;
  const data = await getJson(url);
  const slides = Array.isArray(data && data.slides) ? data.slides : [];
  return slides.map((s) => {
    const note = (s && (s.speaker_note || (s.content && s.content.__speaker_note__))) || '';
    return { index: s.index, note: String(note).trim() };
  });
}

function slideNarrationText(slide, fallbackTitle) {
  if (slide.note && slide.note.length > 0) return slide.note;
  return fallbackTitle || 'Continue.';
}

// Polish on-screen slide text via the LLM: fix capitalization, punctuation,
// missing spaces, and expand terse bullets. Operates on the parsed
// render-spec so we keep all positions/images untouched and only mutate
// the `text` field of each `item.type === 'text'` entry.
async function rewriteSlidesForClarity(slides) {
  const apiKey = process.env.CUSTOM_LLM_API_KEY;
  const baseUrl = (process.env.CUSTOM_LLM_URL || 'https://api.commandcode.ai/provider/v1').replace(/\/+$/, '');
  const model = process.env.CUSTOM_MODEL || 'z-ai/glm-5.3-flash';
  if (!apiKey) throw new Error('CUSTOM_LLM_API_KEY not set; cannot rewrite slides');

  // Collect all text items, sending their text + a stable id so the LLM can
  // tell us which to change.
  const texts = [];
  for (let si = 0; si < slides.length; si++) {
    for (let ii = 0; ii < slides[si].items.length; ii++) {
      const it = slides[si].items[ii];
      if (it.type === 'text' && it.text && it.text.trim().length > 0) {
        texts.push({ id: `${si}.${ii}`, slide: si, text: it.text });
      }
    }
  }
  if (texts.length === 0) return slides;

  const systemPrompt = `You polish on-screen text for slide presentations. Given a JSON list of text items (id + text), return a JSON list with the same ids and corrected text.

Rules:
- Fix capitalization: title-case headings ("Authorization Intent", not "authorization intent"); sentence-case body text; proper nouns correct.
- Fix punctuation: end sentences with periods; use commas correctly; never emit broken run-concat artifacts like "authorizationintent" or "emailphishing" — split them with a space.
- Expand very short or cryptic items (under 4 words) into a clear, learner-friendly sentence or phrase, but keep the same meaning and roughly the same length.
- Do not invent new facts or add commentary.
- Preserve the original language (English, etc.).
- Output JSON only: {"items":[{"id":"0.3","text":"..."},...]} in the same order.`;

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ items: texts }) },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });

  const url = new URL(baseUrl + '/chat/completions');
  const lib = url.protocol === 'http:' ? http : https;
  const raw = await new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`LLM HTTP ${res.statusCode}: ${chunks.slice(0, 500)}`));
          }
          try { resolve(JSON.parse(chunks)); } catch (e) { reject(new Error('bad JSON: ' + e.message)); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const content = raw && raw.choices && raw.choices[0] && raw.choices[0].message && raw.choices[0].message.content;
  if (!content) throw new Error('LLM returned no content: ' + JSON.stringify(raw).slice(0, 200));
  const parsed = JSON.parse(content);
  if (!parsed.items || !Array.isArray(parsed.items)) throw new Error('LLM did not return {items: [...]}');
  const byId = new Map(parsed.items.map((x) => [x.id, x.text]));

  // Apply back to the slides
  for (let si = 0; si < slides.length; si++) {
    for (let ii = 0; ii < slides[si].items.length; ii++) {
      const it = slides[si].items[ii];
      if (it.type !== 'text') continue;
      const id = `${si}.${ii}`;
      if (byId.has(id)) {
        const newText = String(byId.get(id) || '').trim();
        if (newText) it.text = newText;
      }
    }
  }
  return slides;
}

// Rewrite presenter-facing speaker notes into direct student-facing narration.
// Uses the same CUSTOM_LLM_* env vars as Presenton (Command Code provider API).
// Returns slides with the same shape but rewritten `note` text.
async function rewriteNarrationForStudents(slides) {
  const apiKey = process.env.CUSTOM_LLM_API_KEY;
  const baseUrl = (process.env.CUSTOM_LLM_URL || 'https://api.commandcode.ai/provider/v1').replace(/\/+$/, '');
  const model = process.env.CUSTOM_MODEL || 'z-ai/glm-5.3-flash';
  if (!apiKey) throw new Error('CUSTOM_LLM_API_KEY not set; cannot rewrite narration');

  const systemPrompt = `You are rewriting presenter notes from a slide deck into a narration script that will be read aloud by a text-to-speech voice.

The notes were written for a TEACHER to read while presenting. Your job is to convert them into words the VOICE speaks DIRECTLY TO THE STUDENTS.

Rules:
- Address the student as "you" (e.g. "Today you'll learn...", "Notice how...", "Try to think about why...").
- Never use teacher-facing language: no "This slide outlines...", "The presenter should...", "We will cover...", "Today's session...".
- Keep the same length and ideas as the original note. 1-3 sentences per slide.
- Sound like a calm, friendly tutor talking one-on-one to a 12-17 year old.
- Do not invent facts not present in the original.
- Output JSON only: {"slides":[{"index":0,"text":"..."},...]}, one entry per input slide in the same order.`;

  const userPayload = slides.map((s, i) => ({ index: i, text: s.note || `Slide ${i + 1}.` }));

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: JSON.stringify({ slides: userPayload }) },
    ],
    temperature: 0.4,
    response_format: { type: 'json_object' },
  });

  const url = new URL(baseUrl + '/chat/completions');
  const lib = url.protocol === 'http:' ? http : https;
  const raw = await new Promise((resolve, reject) => {
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'Authorization': `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`LLM HTTP ${res.statusCode}: ${chunks.slice(0, 500)}`));
          }
          try { resolve(JSON.parse(chunks)); } catch (e) { reject(new Error('bad JSON: ' + e.message)); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const content = raw && raw.choices && raw.choices[0] && raw.choices[0].message && raw.choices[0].message.content;
  if (!content) throw new Error('LLM returned no content: ' + JSON.stringify(raw).slice(0, 200));
  const parsed = JSON.parse(content);
  if (!parsed.slides || !Array.isArray(parsed.slides)) throw new Error('LLM did not return {slides: [...]}');
  const out = slides.map((s, i) => {
    const found = parsed.slides.find((x) => x && (x.index === i || x.index === s.index));
    return { ...s, note: (found && found.text) ? String(found.text).trim() : s.note };
  });
  return out;
}

// Extract per-slide render data and copy referenced media into deckDir/media/.
// Returns a list of slides: { index, items: [...] } where each item is a
// positioned box (text or image) ready to be composited on a 16:9 canvas.
async function extractSlideRenderData(pptxPath, deckDir) {
  const buf = fs.readFileSync(pptxPath);
  const zip = await JSZip.loadAsync(buf);

  const fileNames = Object.keys(zip.files);
  const slideNames = fileNames
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml$/)[1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml$/)[1], 10);
      return na - nb;
    });

  const mediaDir = path.join(deckDir, 'media');
  if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
  const usedMedia = new Set();

  const slides = [];
  for (let i = 0; i < slideNames.length; i++) {
    const slideName = slideNames[i];
    const slideXml = await zip.files[slideName].async('string');
    const relsName = slideName.replace('slides/', 'slides/_rels/') + '.rels';
    const relsXml = zip.files[relsName]
      ? await zip.files[relsName].async('string')
      : null;
    const relMap = relsXml ? parseRels(relsXml) : {};

    const items = parseSlideItems(slideXml, relMap);
    slides.push({ index: i + 1, items });

    for (const it of items) {
      if (it.type === 'image' && it.mediaPath && !usedMedia.has(it.mediaPath)) {
        usedMedia.add(it.mediaPath);
        const ext = path.extname(it.mediaPath).toLowerCase();
        const safeName = sanitizeMediaName(it.mediaPath);
        const outName = `slide${String(i + 1).padStart(2, '0')}_${path.basename(safeName, ext)}${ext || '.bin'}`;
        const outPath = path.join(mediaDir, outName);
        // JSZip keys for media are like 'ppt/media/foo.png'; mediaPath is 'media/foo.png' (../ stripped).
        const key = `ppt/${it.mediaPath}`;
        if (zip.files[key]) {
          const data = await zip.files[key].async('nodebuffer');
          fs.writeFileSync(outPath, data);
          it.src = `media/${outName}`;
        }
        delete it.mediaPath;
      }
    }
  }
  return slides;
}

function parseRels(xml) {
  const out = {};
  const re = /<Relationship\b([^>]*?)\/?>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const id = (attrs.match(/\bId="([^"]+)"/) || [])[1];
    const target = (attrs.match(/\bTarget="([^"]+)"/) || [])[1];
    if (id && target) out[id] = target;
  }
  return out;
}

function sanitizeMediaName(name) {
  // strip path, replace non-alphanumerics with underscores
  const base = path.basename(name);
  return base.replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Parse a slide's XML into positioned items. We support a subset that
// covers the vast majority of what Presenton emits: solid bg, images,
// and text shapes with positioned runs.
function parseSlideItems(xml, rels) {
  const items = [];

  // Background solid fill
  const bg = (xml.match(/<p:bg>[\s\S]*?<\/p:bg>/) || [''])[0];
  const bgColor = (bg.match(/<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/) || [])[1];
  if (bgColor) items.push({ type: 'bg', color: `#${bgColor}` });

  // Picture elements
  const picRe = /<p:pic>[\s\S]*?<\/p:pic>/g;
  let m;
  while ((m = picRe.exec(xml)) !== null) {
    const block = m[0];
    const off = parseOff(block);
    const ext = parseExt(block);
    const embed = (block.match(/r:embed="(rId\d+)"/) || [])[1];
    if (!off || !ext) continue;
    const target = embed ? rels[embed] : null;
    if (!target) continue;
    // skip iframes to svgs we cannot render (browser handles them)
    const mediaPath = target.replace(/^\.\.\//, '');
    items.push({ type: 'image', x: off.x, y: off.y, w: ext.cx, h: ext.cy, mediaPath });
  }

  // Shape elements with text
  const spRe = /<p:sp>[\s\S]*?<\/p:sp>/g;
  while ((m = spRe.exec(xml)) !== null) {
    const block = m[0];
    const off = parseOff(block);
    const ext = parseExt(block);
    if (!off || !ext) continue;

    // collect text runs in document order, preserving paragraphs
    const text = collectText(block);
    if (text.length === 0) continue;

    // font size (first run that has one)
    const szMatch = block.match(/<a:rPr[^>]*\bsz="(\d+)"/);
    const fontSize = szMatch ? parseInt(szMatch[1], 10) / 100 : null; // hundredths of a point
    // color
    let color = null;
    const cMatch = block.match(/<a:solidFill>[\s\S]*?<a:srgbClr\s+val="([0-9A-Fa-f]{6})"/);
    if (cMatch) color = `#${cMatch[1]}`;
    // bold
    const bold = /<a:rPr[^>]*\bb="1"/.test(block);
    // alignment
    let align = 'left';
    if (/<a:pPr[^>]*algn="ctr"/.test(block)) align = 'center';
    else if (/<a:pPr[^>]*algn="r"/.test(block)) align = 'right';

    items.push({ type: 'text', x: off.x, y: off.y, w: ext.cx, h: ext.cy, text, fontSize, color, bold, align });
  }

  return items;
}

function parseOff(block) {
  const m = block.match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  if (!m) return null;
  return { x: parseInt(m[1], 10), y: parseInt(m[2], 10) };
}
function parseExt(block) {
  const m = block.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
  if (!m) return null;
  return { cx: parseInt(m[1], 10), cy: parseInt(m[2], 10) };
}
function collectText(spBlock) {
  // Walk paragraphs; insert a space between adjacent non-empty runs in the
  // same paragraph to fix Presenton/LibreOffice artifacts like
  // "authorization" + "intent" emitting as "authorizationintent".
  const paras = [];
  const pRe = /<a:p>[\s\S]*?<\/a:p>/g;
  let m;
  while ((m = pRe.exec(spBlock)) !== null) {
    const p = m[0];
    const runs = [];
    const rRe = /<a:r>[\s\S]*?<\/a:r>/g;
    let rm;
    while ((rm = rRe.exec(p)) !== null) {
      const t = (rm[0].match(/<a:t>([\s\S]*?)<\/a:t>/) || [])[1] || '';
      runs.push(decodeXml(t));
    }
    paras.push(joinRuns(runs));
  }
  return paras.join('\n');
}

// Join text runs in a paragraph, inserting a space between two non-empty
// runs that lack any separator at the boundary.
function joinRuns(runs) {
  let out = '';
  for (const r of runs) {
    if (!r) { out += r; continue; }
    if (!out) { out = r; continue; }
    const last = out.slice(-1);
    const first = r[0];
    const lastIsSpace = /\s/.test(last);
    const firstIsPunct = /[.,!?;:]/.test(first);
    const lastIsPunct = /[.,!?;:]/.test(last);
    if (!lastIsSpace && !firstIsPunct && !lastIsPunct) {
      out += ' ' + r;
    } else {
      out += r;
    }
  }
  return out;
}
function decodeXml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// Probe an audio file's duration in seconds using ffmpeg.
const { spawnSync } = require('child_process');
function probeAudioDurationSeconds(filePath) {
  const r = spawnSync(ffmpegPath, ['-i', filePath, '-f', 'null', '-'], { encoding: 'utf8' });
  const m = (r.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
}

async function generateVoiceover(slides, deckDir) {
  const TTS_TIMEOUT_MS = 5 * 60 * 1000;

  async function ttsOnce(text) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (TTS_API_KEY) headers['Authorization'] = `Bearer ${TTS_API_KEY}`;
      const resp = await fetch(TTS_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: TTS_MODEL,
          input: text,
          voice: TTS_VOICE,
          response_format: 'mp3',
          speed: 1.0,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        throw new Error(`TTS HTTP ${resp.status}: ${errBody.slice(0, 200)}`);
      }
      const ab = await resp.arrayBuffer();
      const buf = Buffer.from(ab);
      if (buf.length < 100) {
        throw new Error(`TTS returned ${buf.length} bytes (likely empty)`);
      }
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  async function ttsWithRetry(text) {
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await ttsOnce(text);
      } catch (e) {
        lastErr = e;
        if (attempt === 2) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    throw lastErr;
  }

  const segPaths = new Array(slides.length);
  const queue = slides.map((_, i) => i);
  const workers = Array.from({ length: Math.min(TTS_CONCURRENCY, slides.length) }, async () => {
    while (queue.length) {
      const i = queue.shift();
      const text = slideNarrationText(slides[i], `Slide ${i + 1}.`);
      console.log(`        [tts ${i + 1}/${slides.length}] ${text.length} chars`);
      const buf = await ttsWithRetry(text);
      const segPath = path.join(deckDir, `_seg_${String(i).padStart(2, '0')}.mp3`);
      fs.writeFileSync(segPath, buf);
      segPaths[i] = segPath;
    }
  });
  try {
    await Promise.all(workers);
  } catch (e) {
    throw new Error(`TTS failed: ${e.message}`);
  }

  const segments = segPaths;
  if (segments.length === 0 || segments.some((p) => !p)) {
    throw new Error('No TTS segments produced');
  }

  // Probe per-segment durations so the viewer can sync slide changes to audio.
  const segDurations = segments.map((p) => probeAudioDurationSeconds(p));

  // Build a concat list with 600ms silence inserted between segments.
  // Generate the silence once, then interleave it with the per-slide
  // segments in the concat demuxer list.
  const listPath = path.join(deckDir, '_concat.txt');
  const outPath = path.join(deckDir, 'voiceover.mp3');
  const silencePath = path.join(deckDir, '_silence.mp3');
  const SILENCE_S = 0.6;
  execFileSync(ffmpegPath, [
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=mono:sample_rate=24000',
    '-t', String(SILENCE_S), '-q:a', '9', '-acodec', 'libmp3lame', '-y', silencePath,
  ], { stdio: 'ignore' });

  const mixedList = [];
  segments.forEach((p, i) => {
    mixedList.push(`file '${p.replace(/'/g, "'\\''")}'`);
    if (i < segments.length - 1) {
      mixedList.push(`file '${silencePath.replace(/'/g, "'\\''")}'`);
    }
  });
  fs.writeFileSync(listPath, mixedList.join('\n'));

  execFileSync(ffmpegPath, [
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy', '-y', outPath,
  ], { stdio: 'ignore' });

  for (const p of segments) {
    try { fs.unlinkSync(p); } catch (_) { /* ignore */ }
  }
  try { fs.unlinkSync(silencePath); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(listPath); } catch (_) { /* ignore */ }

  // Build per-slide timings: { index, start, end } in seconds. Silence
  // gaps are attributed to the *following* slide so the slide change
  // happens just before narration starts.
  const timings = [];
  let cursor = 0;
  for (let i = 0; i < segments.length; i++) {
    const start = cursor;
    cursor += segDurations[i];
    const end = (i < segments.length - 1) ? cursor + SILENCE_S : cursor;
    timings.push({ index: i, start, end });
    cursor = end;
  }

  const stat = fs.statSync(outPath);
  console.log(`        voiceover.mp3 (${stat.size} bytes, voice=${TTS_VOICE}, concurrency=${TTS_CONCURRENCY}, total=${cursor.toFixed(1)}s)`);
  return { path: outPath, timings };
}

// Render a pptx to per-slide PNGs using the LibreOffice headless Docker image.
// Requires: docker available on the host, pdf2slides-renderer image built
// (npm run build:renderer). Throws if the image is missing or docker fails.
// Returns { slideW, slideH, slides: [{ index, src }] }
async function renderSlidesViaLibreOffice(pptxPath, deckDir) {
  const { spawnSync } = require('child_process');
  const deckName = path.basename(deckDir);
  const pptxName = path.basename(pptxPath);
  const slidesDir = path.join(deckDir, 'slides');
  if (!fs.existsSync(slidesDir)) fs.mkdirSync(slidesDir, { recursive: true });

  // Check that docker and the image exist
  const check = spawnSync('docker', ['image', 'inspect', 'pdf2slides-renderer:latest'], { stdio: 'pipe' });
  if (check.status !== 0) {
    throw new Error('pdf2slides-renderer:latest image not found. Run: npm run build:renderer');
  }

  const mountsDir = path.resolve(path.join(deckDir, '..'));
  const volArg = `${mountsDir.replace(/\\/g, '/')}:/work`;
  const inArg = `/work/${deckName}/${pptxName}`;
  const outArg = `/work/${deckName}/slides`;

  console.log(`        rendering via docker: ${pptxName} → slides/`);
  const r = spawnSync('docker', [
    'run', '--rm',
    '-v', volArg,
    'pdf2slides-renderer:latest',
    inArg, outArg, '150',
  ], { stdio: 'pipe', timeout: 120000, encoding: 'utf8' });

  if (r.status !== 0) {
    const err = (r.stderr || r.stdout || '').trim().slice(0, 500);
    throw new Error(`docker render failed (exit ${r.status}): ${err}`);
  }

  // Read produced PNGs
  const pngs = fs.readdirSync(slidesDir)
    .filter((f) => f.startsWith('slide-') && f.endsWith('.png'))
    .sort();
  if (pngs.length === 0) throw new Error('renderer produced no PNG files');

  // Probe first image to get dimensions
  let slideW = 1920, slideH = 1080;
  try {
    const probe = spawnSync('file', [path.join(slidesDir, pngs[0])], { stdio: 'pipe', encoding: 'utf8' });
    const m = (probe.stdout || '').match(/(\d+)\s*x\s*(\d+)/);
    if (m) { slideW = parseInt(m[1], 10); slideH = parseInt(m[2], 10); }
  } catch (_) {}

  const slides = pngs.map((f, i) => ({
    index: i + 1,
    src: `slides/${f}`,
  }));

  return { slideW, slideH, slides };
}

async function processPDF(pdfPath, deckDir, options = {}) {
  const wantVoiceover = options.voiceover === true;
  // Per-request slide count override (defaults to env PPT_SLIDES).
  const nSlides = Math.max(1, parseInt(options.slides, 10) || N_SLIDES);
  console.log('  [1/4] Uploading PDF to Presenton...');
  const uploadUrl = `${PRESENTON_URL}/api/v1/ppt/files/upload`;
  const uploaded = await postMultipart(uploadUrl, pdfPath, 'files');
  let fileId;
  let remotePath;
  if (typeof uploaded === 'string') {
    remotePath = uploaded;
    fileId = path.basename(uploaded);
  } else if (Array.isArray(uploaded) && uploaded.length > 0) {
    const first = uploaded[0];
    if (typeof first === 'string') {
      remotePath = first;
      fileId = path.basename(first);
    } else if (first && typeof first === 'object') {
      fileId = first.file_id || first.id || first.fileId;
      remotePath = first.path || (fileId ? `/tmp/presenton/${fileId}` : null);
    }
  } else if (uploaded && typeof uploaded === 'object') {
    fileId = uploaded.file_id || uploaded.id || uploaded.fileId
      || (uploaded.data && (uploaded.data.file_id || uploaded.data.id));
    remotePath = uploaded.path || (uploaded.data && uploaded.data.path)
      || (fileId ? `/tmp/presenton/${fileId}` : null);
    if (!fileId && remotePath) fileId = path.basename(remotePath);
    if (!fileId && Array.isArray(uploaded.files) && uploaded.files[0]) {
      const f = uploaded.files[0];
      fileId = f.file_id || f.id || (f.path ? path.basename(f.path) : null);
      remotePath = f.path || remotePath;
    }
  }
  if (!fileId) {
    throw new Error(`Presenton upload did not return a file_id: ${JSON.stringify(uploaded).slice(0, 500)}`);
  }
  console.log(`        file_id: ${fileId}`);

  console.log('  [2/4] Generating presentation...');
  const generateUrl = `${PRESENTON_URL}/api/v1/ppt/presentation/generate`;
  const payload = {
    content: 'Generate a professional presentation from this document.',
    files: [remotePath || fileId],
    n_slides: nSlides,
    template: TEMPLATE,
    tone: TONE,
    verbosity: VERBOSITY,
    language: LANGUAGE,
    include_title_slide: INCLUDE_TITLE,
    include_table_of_contents: INCLUDE_TOC,
    export_as: 'pptx',
  };
  const result = await (async () => {
    const MAX_ATTEMPTS = 3;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const r = await postJson(generateUrl, payload);
        if (r && (r.path || (r.data && r.data.path))) return r;
        lastErr = new Error(`no path in response: ${JSON.stringify(r).slice(0, 300)}`);
      } catch (e) {
        lastErr = e;
      }
      if (attempt < MAX_ATTEMPTS) {
        const wait = 4000 * attempt;
        console.log(`        attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying in ${wait / 1000}s: ${lastErr.message.slice(0, 120)}`);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
    throw new Error(`Presenton generate failed after ${MAX_ATTEMPTS} attempts: ${lastErr.message}`);
  })();
  const resultPath = result && (result.path || (result.data && result.data.path));
  const presentationId = result && (result.presentation_id || (result.data && result.data.presentation_id));
  if (!resultPath) {
    throw new Error(`Presenton generate did not return a path: ${JSON.stringify(result).slice(0, 500)}`);
  }
  const outputRemote = resultPath;
  console.log(`        presentation_id: ${presentationId}`);
  console.log(`        remote path: ${outputRemote}`);

  console.log('  [3/4] Fetching .pptx into deck folder...');
  const pptxPath = path.join(deckDir, 'deck.pptx');

  // Try the shared-volume path first (works when ./app_data is mounted into
  // both containers). If the file is not there, fall back to downloading
  // from Presenton over HTTP. Presenton's `path` is usually a server-relative
  // URL like /app_data/<uuid>/<file>.pptx that nginx serves directly.
  const localSource = resolvePresentonPath(outputRemote);
  let copied = false;
  if (localSource && fs.existsSync(localSource)) {
    await copyFile(localSource, pptxPath);
    copied = true;
    console.log(`        copied from ${localSource}`);
  } else {
    let downloadUrl;
    if (/^https?:\/\//i.test(outputRemote)) {
      downloadUrl = outputRemote;
    } else {
      downloadUrl = `${PRESENTON_URL}${outputRemote.startsWith('/') ? '' : '/'}${outputRemote}`;
    }
    console.log(`        downloading ${downloadUrl}`);
    await downloadToFile(downloadUrl, pptxPath);
    copied = true;
    console.log(`        downloaded`);
  }

  if (!copied || !fs.existsSync(pptxPath)) {
    throw new Error(`Failed to obtain .pptx for ${outputRemote}`);
  }
  const stats = fs.statSync(pptxPath);
  console.log(`        saved: ${pptxPath} (${stats.size} bytes)`);

  return finalizeDeck(deckDir, pptxPath, {
    title: path.basename(outputRemote, path.extname(outputRemote)),
    slideCount: nSlides,
    presentationId,
    template: TEMPLATE,
    wantVoiceover,
  });
}

// Shared tail of the pipeline: voiceover generation (optional), slide
// render-data extraction, and manifest write. Used by both processPDF and
// processContent so the embed API gets identical post-processing.
async function finalizeDeck(deckDir, pptxPath, opts) {
  const manifest = {
    deckId: path.basename(deckDir),
    title: opts.title,
    slideCount: opts.slideCount,
    pptxUrl: `/decks/${path.basename(deckDir)}/deck.pptx`,
    pptxBytes: fs.statSync(pptxPath).size,
    presentationId: opts.presentationId || null,
    template: opts.template || TEMPLATE,
    generatedAt: new Date().toISOString(),
  };

  if (opts.wantVoiceover) {
    console.log('  [4/5] Generating voiceover...');
    let slides = [];
    try {
      slides = await fetchSlides(opts.presentationId);
      console.log(`        fetched ${slides.length} slide notes`);
    } catch (e) {
      console.log(`        could not fetch slide notes: ${e.message}`);
    }
    if (slides.length === 0) {
      slides = Array.from({ length: opts.slideCount }, (_, i) => ({
        index: i,
        note: `Slide ${i + 1}.`,
      }));
    }
    // Optionally rewrite the notes through the LLM so narration is direct
    // student-facing speech instead of presenter-facing notes.
    if (process.env.NARRATION_REWRITE === '1' && slides.some(s => s.note)) {
      try {
        slides = await rewriteNarrationForStudents(slides);
        console.log('        narration rewritten for student-facing tone');
      } catch (e) {
        console.log(`        narration rewrite failed, using raw notes: ${e.message}`);
      }
    }
    const voiceover = await generateVoiceover(slides, deckDir);
    const vstats = fs.statSync(voiceover.path);
    manifest.voiceoverUrl = `/decks/${path.basename(deckDir)}/voiceover.mp3`;
    manifest.voiceoverBytes = vstats.size;
    manifest.voiceoverSlides = slides.length;
    manifest.slideTimings = voiceover.timings;

    console.log('  [5/5] Extracting slide render data for browser viewer...');
    let renderObj = null;
    try {
      // Try raster rendering first (pixel-perfect via LibreOffice).
      // Falls back to text-compositing if the renderer image isn't built
      // or docker isn't available.
      const useRaster = process.env.USE_RENDERER !== '0';
      let raster = null;
      if (useRaster) {
        try {
          raster = await renderSlidesViaLibreOffice(pptxPath, deckDir);
        } catch (e) {
          console.log(`        raster render unavailable, falling back to text compositor: ${e.message}`);
        }
      }
      if (raster && raster.slides.length) {
        renderObj = { mode: 'raster', ...raster };
        console.log(`        raster: ${raster.slides.length} slides @ ${raster.slideW}×${raster.slideH}`);
      } else {
        // Fall back to text-composited rendering
        let renderSlides = await extractSlideRenderData(pptxPath, deckDir);
        if (process.env.SLIDES_REWRITE === '1' && renderSlides.length) {
          try {
            renderSlides = await rewriteSlidesForClarity(renderSlides);
            console.log('        slide text polished via LLM');
          } catch (e) {
            console.log(`        slide polish failed, using raw text: ${e.message}`);
          }
        }
        renderObj = { mode: 'composited', slideW: SLIDE_W, slideH: SLIDE_H, slides: renderSlides };
        console.log(`        composited: ${renderSlides.length} slides, ${renderSlides.reduce((n, s) => n + s.items.length, 0)} items`);
      }
      fs.writeFileSync(
        path.join(deckDir, 'render.json'),
        JSON.stringify(renderObj, null, 2)
      );
      manifest.viewerUrl = `/decks/${path.basename(deckDir)}/view`;
    } catch (e) {
      console.log(`        could not extract render data: ${e.message}`);
    }
  }

  fs.writeFileSync(path.join(deckDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return manifest;
}

// Content-driven variant of processPDF for the /api/embed endpoint.
// Accepts either a plain string (used as the Presenton generation prompt) or
// an array of slide texts (passed as slides_markdown so each array item maps
// to one slide). Everything downstream of generation is identical to
// processPDF: fetch pptx -> voiceover -> render -> manifest.
async function processContent(contentInput, deckDir, options = {}) {
  const wantVoiceover = options.voiceover === true;

  console.log('  [1/3] Generating presentation from content...');
  const generateUrl = `${PRESENTON_URL}/api/v1/ppt/presentation/generate`;
  const nSlides = Math.max(1, parseInt(options.slides, 10) || N_SLIDES);
  const template = options.template || TEMPLATE;
  const tone = options.tone || TONE;
  const language = options.language || LANGUAGE;

  const basePayload = {
    template,
    tone,
    verbosity: VERBOSITY,
    language,
    include_title_slide: INCLUDE_TITLE,
    include_table_of_contents: INCLUDE_TOC,
    export_as: 'pptx',
  };

  let payload;
  let slideCount;
  if (Array.isArray(contentInput) && contentInput.length > 0) {
    payload = {
      ...basePayload,
      slides_markdown: contentInput.map((s) => String(s)),
      n_slides: contentInput.length,
    };
    slideCount = contentInput.length;
  } else {
    const text = String(contentInput || '').trim();
    if (!text) throw new Error('content must be a non-empty string or array');
    payload = { ...basePayload, content: text, n_slides: nSlides };
    slideCount = nSlides;
  }

  const result = await (async () => {
    const MAX_ATTEMPTS = 3;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const r = await postJson(generateUrl, payload);
        if (r && (r.path || (r.data && r.data.path))) return r;
        lastErr = new Error(`no path in response: ${JSON.stringify(r).slice(0, 300)}`);
      } catch (e) {
        lastErr = e;
      }
      if (attempt < MAX_ATTEMPTS) {
        const wait = 4000 * attempt;
        console.log(`        attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying in ${wait / 1000}s: ${lastErr.message.slice(0, 120)}`);
        await new Promise((res) => setTimeout(res, wait));
      }
    }
    throw new Error(`Presenton generate failed after ${MAX_ATTEMPTS} attempts: ${lastErr.message}`);
  })();
  const resultPath = result && (result.path || (result.data && result.data.path));
  const presentationId = result && (result.presentation_id || (result.data && result.data.presentation_id));
  if (!resultPath) {
    throw new Error(`Presenton generate did not return a path: ${JSON.stringify(result).slice(0, 500)}`);
  }
  const outputRemote = resultPath;
  console.log(`        presentation_id: ${presentationId}`);
  console.log(`        remote path: ${outputRemote}`);

  console.log('  [2/3] Fetching .pptx into deck folder...');
  const pptxPath = path.join(deckDir, 'deck.pptx');
  const localSource = resolvePresentonPath(outputRemote);
  let copied = false;
  if (localSource && fs.existsSync(localSource)) {
    await copyFile(localSource, pptxPath);
    copied = true;
    console.log(`        copied from ${localSource}`);
  } else {
    let downloadUrl;
    if (/^https?:\/\//i.test(outputRemote)) {
      downloadUrl = outputRemote;
    } else {
      downloadUrl = `${PRESENTON_URL}${outputRemote.startsWith('/') ? '' : '/'}${outputRemote}`;
    }
    console.log(`        downloading ${downloadUrl}`);
    await downloadToFile(downloadUrl, pptxPath);
    copied = true;
  }
  if (!copied || !fs.existsSync(pptxPath)) {
    throw new Error(`Failed to obtain .pptx for ${outputRemote}`);
  }
  console.log(`        saved: ${pptxPath} (${fs.statSync(pptxPath).size} bytes)`);

  const rawTitle = Array.isArray(contentInput)
    ? String(contentInput[0] || '')
    : String(contentInput || '');
  const title = rawTitle.replace(/[|#*\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Presentation';

  console.log('  [3/3] Finalizing deck...');
  return finalizeDeck(deckDir, pptxPath, {
    title,
    slideCount,
    presentationId,
    template,
    wantVoiceover,
  });
}

module.exports = { processPDF, processContent };
