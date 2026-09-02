# PDF to Slides

Upload a PDF, get back a polished, editable `.pptx` deck.

This app is a thin Express frontend that talks to a self-hosted
[Presenton](https://github.com/presenton/presenton) container, which does
the actual generation (LLM outline + template layout + stock photos) and
writes a real PowerPoint file you can open in PowerPoint, Google Slides,
or Keynote.

```
[Browser at localhost:3005]
        | uploads PDF
        v
[Node/Express app]
        |  POST /api/v1/ppt/files/upload
        |  POST /api/v1/ppt/presentation/generate
        v
[Presenton container at localhost:5001]
        |  Gemini API (LLM) + Pexels (images)
        v
[Shared ./app_data volume]
        v
[Express serves ./decks/<id>/deck.pptx]
        |
        v  (optional: LibreOffice renderer)
[PNG slides rendered per-deck in ./decks/<id>/slides/]
```

## Prerequisites

1. **Docker Desktop for Windows** -- https://www.docker.com/products/docker-desktop/
2. **Command Code account + API key** (Pro or higher for Provider API access) -- https://commandcode.ai/settings
3. **Pexels API key** -- https://www.pexels.com/api/ (200 req/hour, free, no card)

## Quick start

```powershell
# 1. Clone / cd into the project
cd C:\path\to\pdf-to-slides

# 2. Configure
copy .env.example .env
# Open .env and set CUSTOM_LLM_API_KEY and PEXELS_API_KEY

# 3. Start Presenton (one-time, first pull is ~2GB)
docker run -d --name presenton -p 5001:80 `
  -e LLM="custom" `
  -e CUSTOM_LLM_URL="https://api.commandcode.ai/provider/v1" `
  -e CUSTOM_LLM_API_KEY="<your-commandcode-key>" `
  -e CUSTOM_MODEL="z-ai/glm-5.3-flash" `
  -e IMAGE_PROVIDER="pexels" `
  -e PEXELS_API_KEY="<your-pexels-key>" `
  -e CAN_CHANGE_KEYS="false" `
  -e DISABLE_AUTH="true" `
  -v "${PWD}\app_data:/app_data" `
  ghcr.io/presenton/presenton:latest

Start-Sleep -Seconds 8
docker ps --filter name=presenton
docker logs --tail 20 presenton

# 4. Start the app
npm install
npm start

# 5. Open http://localhost:3005 and upload a PDF
```

Or, with `docker compose` (brings up Presenton **and** the Kokoro TTS service **and** the app together):

```powershell
docker compose up --build
```

This starts three services:
- `presenton` on `http://localhost:5001` (the slides generator)
- `tts` on `http://localhost:8880` (Kokoro-FastAPI, voiceover)
- `app` on `http://localhost:3005` (this Node frontend)

When using compose, the app talks to Presenton at `http://presenton`
(via the internal Docker network, port 80). `PRESENTON_URL` is set automatically in
`docker-compose.yml`. TTS defaults to **OpenAI TTS** (cloud, ~$0.045 per
10-slide deck) so there's no local TTS container. The Kokoro container
is included in the compose file as commented-out YAML; uncomment it if
you want to self-host TTS instead.

## How to use

1. Open `http://localhost:3005`
2. Drop a PDF in the upload zone (50 MB max)
3. Wait 30-90 seconds for slides, plus ~1-2 minutes if voiceover is enabled
4. Click **Download .pptx** (or **Download .zip (slides + audio)** if voiceover is on)
5. Open in PowerPoint, Google Slides, or Keynote -- fully editable

### Slide renderer (pixel-perfect viewer)

By default the in-browser viewer composites text + images from parsed PPTX data.
For pixel-perfect slides, build the LibreOffice renderer and enable it:

```powershell
# 1. Build the renderer image (one-time, ~800MB)
npm run build:renderer

# 2. Set USE_RENDERER=1 in .env
echo USE_RENDERER=1 >> .env
```

Each deck will then render to `decks/<id>/slides/slide-01.png` ... `slide-N.png`
(150dpi, 16:9) via headless LibreOffice inside a Docker container. The viewer
shows these PNGs directly -- identical to opening the .pptx in PowerPoint.

Disable with `USE_RENDERER=0` in `.env` (falls back to text compositor).

### Voiceover output

With the "Add voiceover narration" checkbox on, the download is a `.zip` containing:

- `deck.pptx` -- the same editable presentation
- `voiceover.mp3` -- a single concatenated narration with ~600ms silence between slides

TTS requests to the provider are issued in parallel (default 6 concurrent for OpenAI,
4 for the local Kokoro CPU image). Tune with `TTS_CONCURRENCY` in `.env`.

After generation you'll see a green **▶ Play in browser** button. This opens an
in-browser viewer that renders the actual slides (text + images + layout from the
`.pptx`) and plays the voiceover, advancing slides in sync with the audio. Keyboard:
`Space` = play/pause, `←/→` = prev/next slide, `R` = restart.

## Embed API

Generate a presentation from raw content (no PDF upload needed) and get back an
iframe-ready embed code with full slide rendering and playback controls.

### POST `/api/embed`

**Request body (JSON):**

```json
{
  "content": "Welcome to Ethical Hacking|Phishing attacks exploit trust|Social engineering techniques",
  "voiceover": true,
  "voice": "nova",
  "slides": 10,
  "template": "minimal",
  "tone": "educational",
  "language": "English",
  "autoplay": false
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `content` | string \| string[] | yes | A plain-text generation prompt, or an array of slide texts (one per slide) |
| `voiceover` | boolean | no | Generate narration audio (default `false`) |
| `voice` | string | no | Override `TTS_VOICE` for this request |
| `slides` | number | no | Target slide count (1-50, string input only; default from `PPT_SLIDES`) |
| `template` | string | no | Presenton template (default from `PPT_TEMPLATE`) |
| `tone` | string | no | Presenton tone (default from `PPT_TONE`) |
| `language` | string | no | Presenton language (default from `PPT_LANGUAGE`) |
| `autoplay` | boolean | no | Start playback when the iframe loads (`&autoplay=1`) |

**Response (200):**

```json
{
  "success": true,
  "deckId": "3f1a2b...",
  "iframeSrc": "https://host/decks/3f1a2b.../view?embed=1&autoplay=0",
  "embedCode": "<iframe src=\"https://host/decks/3f1a2b.../view?embed=1&autoplay=0\" width=\"960\" height=\"540\" frameborder=\"0\" allow=\"autoplay; fullscreen\" allowfullscreen></iframe>",
  "viewerUrl": "/decks/3f1a2b.../view",
  "manifest": { "deckId": "...", "title": "...", "slideTimings": [...] }
}
```

**Auth:** if `API_TOKEN` is set in `.env`, send `Authorization: Bearer <token>`.

**CORS:** GET requests (viewer assets) always allow any origin. POST
`/api/embed` respects `EMBED_ALLOWED_ORIGINS` (default `*`).

### Using the embed code

Paste the returned `embedCode` anywhere that accepts raw HTML:

```html
<iframe src="https://pdf-api.example.com/decks/3f1a2b.../view?embed=1&autoplay=0"
        width="960" height="540" frameborder="0"
        allow="autoplay; fullscreen" allowfullscreen></iframe>
```

The viewer in embed mode shows a slim always-visible control strip at the
bottom: play/pause, prev/next slide, mute, restart, fullscreen, and a seek
bar. **Mute is independent of auto-advance** — muting makes the voiceover
inaudible but slides still advance on their timing.

Notes:
- Browsers require a user gesture to start audio. `autoplay: true` works when
  the parent page has already received a gesture (and the iframe has
  `allow="autoplay"`), but Chrome may still block the first play.
- Keyboard shortcuts work in the iframe once the user clicks inside it:
  `Space` play/pause, `←/→` prev/next slide, `M` mute, `R` restart, `F` fullscreen.

## Configuration

All settings live in `.env`:

| Variable            | Default                  | Notes |
|---------------------|--------------------------|-------|
| `PRESENTON_URL`     | `http://localhost:5001`  | Where Presenton is reachable. Inside Docker Compose this is `http://presenton` (port 80) |
| `TTS_URL`           | `https://api.openai.com/v1/audio/speech` | Any OpenAI-compatible TTS endpoint |
| `TTS_VOICE`         | `nova`                   | OpenAI: `alloy`/`nova`/`shimmer`/`onyx`/etc. Kokoro: `af_heart`/`af_bella`/etc. |
| `TTS_MODEL`         | `tts-1`                  | `tts-1` (fast) or `tts-1-hd` (higher quality, same price) |
| `OPENAI_API_KEY`    | (none)                   | Required when `TTS_URL` is OpenAI. New accounts get $5 free credit (~111 decks) |
| `TTS_CONCURRENCY`   | `6`                      | Parallel TTS requests while generating voiceover |
| `PPT_TEMPLATE`      | `general`                | One of Presenton's built-in templates |
| `PPT_SLIDES`        | `10`                     | Target slide count |
| `PPT_TONE`          | `educational`            | `educational`, `professional`, `casual`, etc. |
| `PPT_LANGUAGE`      | `English`                | Any language Presenton supports |
| `PPT_VERBOSITY`     | `standard`               | `concise`, `standard`, `detailed` |
| `PPT_INCLUDE_TITLE` | `true`                   | Add a title slide |
| `PPT_INCLUDE_TOC`   | `false`                  | Add a table of contents slide |
| `NARRATION_REWRITE` | `0`                      | Rewrite speaker notes into student-facing narration via LLM |
| `SLIDES_REWRITE`    | `0`                      | Polish on-screen text (capitalization, punctuation) via LLM |
| `USE_RENDERER`      | `1`                      | Render slides to PNGs via LibreOffice (requires `npm run build:renderer`) |
| `API_TOKEN`         | (none)                   | If set, requires `Authorization: Bearer <token>` on `/api/upload` and `/api/embed` |
| `EMBED_ALLOWED_ORIGINS` | `*`                  | Comma-separated origins allowed to call `POST /api/embed` |
| `PORT`              | `3005`                   | Express port |
| `REQUEST_TIMEOUT_MS`| `600000`                 | Max time to wait for Presenton + Kokoro (default 10 min) |

## Troubleshooting

**Presenton container won't start / `app_data` mount fails on Windows**

Use the `${PWD}\app_data:/app_data` form in PowerShell as shown above.
If the volume is already populated by a different user/path, remove it
with `docker volume prune` or delete the local `app_data\` folder.

**`HTTP 500` from Presenton when generating**

Check `docker logs presenton`. The most common causes are a missing or
empty `CUSTOM_LLM_API_KEY`, a model id that doesn't exist on Command
Code, or a Command Code plan that doesn't include Provider API access
(Go plan returns 403; Pro+ is required).

**Pexels images missing**

Without `PEXELS_API_KEY`, Presenton silently falls back to text-only
slides. Add the key to enable stock photos.

**Generation takes longer than 5 minutes**

The Express timeout defaults to 10 minutes (`REQUEST_TIMEOUT_MS=600000`).
Presenton is typically 30-90s; voiceover adds another 1-2 min on the CPU
Kokoro image. Very large PDFs (200+ pages) can take a few minutes. Bump
`REQUEST_TIMEOUT_MS` if you need more headroom.

**First Presenton pull is 2GB**

Expected. The image caches locally after the first pull.

**Voiceover step fails with `TTS HTTP 401`**

The `OPENAI_API_KEY` is missing or invalid. Create a key at
https://platform.openai.com/api-keys, set it in `.env`, restart the
server. New accounts get $5 of free credit, valid 3 months.

**Voiceover step fails with `TTS HTTP 429` (rate limit)**

OpenAI rate-limits per-organization. Lower `TTS_CONCURRENCY` in `.env`
to 2-3 and retry. Paid accounts have higher limits; the free tier
is throttled to ~3-5 req/min for TTS specifically.

**Voiceover step fails with `TTS HTTP 5xx`**

Transient OpenAI outage. The pipeline retries each slide once; if it
still fails, retry the upload. Check https://status.openai.com for
incidents.

**Want to self-host TTS instead of OpenAI**

Uncomment the `tts:` block in `docker-compose.yml` and re-add `tts` to
the `app` service's `depends_on`. Then set in `.env`:

```
TTS_URL=http://tts:8880/v1/audio/speech
TTS_VOICE=af_heart
TTS_CONCURRENCY=4
```

The Kokoro CPU image is ~2 GB and processes one request at a time
internally, so a 10-slide deck takes ~4-6 minutes even with
concurrency. For production self-hosting, use the GPU image
(`ghcr.io/remsky/kokoro-fastapi-gpu:latest`) on a host with CUDA.

**Voiceover download is a `.zip`, not a `.pptx`**

Expected. The zip contains `deck.pptx` plus `voiceover.mp3`; unzip to
get both files. PowerPoint, Google Slides, and Keynote do not embed
separate audio tracks via this API, so the narration ships alongside
the deck.

**Want to run Presenton without Docker (fallback)**

Presenton is a Python app. See the upstream README:
https://github.com/presenton/presenton. Requires Python 3.11 + `uv`.

## Architecture notes

- Express only ever talks to Presenton on the same host. There is no
  auth between them (Presenton runs with `DISABLE_AUTH=true` for the
  demo).
- Both services share `./app_data` as a volume. Presenton writes the
  generated `.pptx` there; Express copies it into `./decks/<uuid>/` so
  it can be served as a static file.
- No cloud services are used beyond the user's own Command Code + Pexels keys.
- The app is single-user / demo-grade. No rate limiting, no auth, no
  cleanup of old decks.

## Production checklist (not in scope for the demo)

- Put Express behind nginx with TLS (see `MIGRATION.md` for a Caddy setup)
- Enable Presenton auth (`DISABLE_AUTH=false`) and add an API key
- Set `API_TOKEN` in `.env` to lock down `/api/upload` and `/api/embed`
- Restrict `EMBED_ALLOWED_ORIGINS` once you know the embedding site's origin
- Add a cron job to delete `./decks/*` older than N days
- Move `./app_data` to a persistent volume / S3
- Add a queue + worker if you expect >1 concurrent user

## Migrating to a new server

See [`MIGRATION.md`](MIGRATION.md) for the full Linode migration guide:
backup, provision, Docker install, deploy, restore, reverse proxy, DNS,
smoke test, and decommission steps.

## License

MIT for the code in this repo. Presenton is Apache 2.0
(https://github.com/presenton/presenton).
