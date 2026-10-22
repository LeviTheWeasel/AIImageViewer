# AIImageViewer

Desktop viewer for AI-generated images and their metadata. Electron + React + TypeScript.

Currently reads **ComfyUI PNGs**: positive/negative prompts per sampling stage (KSampler, FaceDetailer, guiders),
checkpoint/UNet/CLIP/VAE, LoRAs with strengths, latent size, and whether the file carries a full UI workflow
or only the API prompt.

## Develop

```bash
pnpm install
pnpm dev          # app with hot reload
pnpm typecheck
pnpm survey <folder> [--verbose]   # run the metadata parser over a folder, no UI
```

## Package

```bash
pnpm dist:linux   # AppImage + deb → dist/
pnpm dist:mac     # dmg, x64 + arm64 (run on macOS)
pnpm dist:win     # NSIS installer (on Linux needs wine)
```

Release builds for all three platforms run on GitHub Actions: push a `v*` tag and
`.github/workflows/release.yml` builds them and creates a draft release with the files attached.

The builds aren't signed with a paid certificate. On macOS the app is ad-hoc signed, so the first launch
needs right-click → Open (or `xattr -cr /Applications/AIImageViewer.app`); Windows SmartScreen asks for
"More info → Run anyway".

## How the ComfyUI parser works (`src/shared/comfy.ts`)

1. Parse the `prompt` text chunk (API graph). `workflow` is only used for the "has workflow" badge and export.
2. Pick the SaveImage node whose `filename_prefix` matches the file name; fall back to all output nodes.
3. Walk upstream from it. Any node with a `positive` input is a sampling stage; its conditioning is walked
   (skipping `clip`/`model`/image inputs) to text encoders.
4. Encoder text is evaluated statically through Primitive / StringConcatenate / StringReplace / StringTrim.
   Anything else (e.g. TextGenerate) becomes a `⟨Class #id⟩` placeholder, with the input it received.

## Keeping LLM-generated prompts

ComfyUI embeds the graph at queue time, so text produced while it runs (TextGenerate etc.) is not in the PNG.
The companion custom node `SaveImageWithText` (“Save Image (+ final prompt)”, distributed separately as
[ComfyUI-SaveImageWithText](https://github.com/LeviTheWeasel/ComfyUI-SaveImageWithText)) saves like SaveImage and adds two chunks:
`final_prompt` (the text) and `final_prompt_source` (id of the node that produced it). The viewer substitutes
that text for the source node's output, so the prompt shows exactly what the encoder received.

## Folders

Several top-level folders can be open at once (Add folder… or drop a folder onto the window); × on a root removes it
from the viewer, never from disk. A folder inside an already added one isn't added twice — the tree just jumps to it,
and adding a parent absorbs roots nested in it. Unreachable roots (unmounted drive) stay listed as "unavailable".
"Subfolders" decides whether the selected folder also shows images from its subfolders.

## Search

Ctrl/Cmd+F focuses the search box. All words must match; by default they're looked up in positive prompts, LoRA and
model names and the file name. `"two words"` is a phrase, `-word` excludes, and `neg:` `lora:` `model:` `seed:` `file:`
search one field (`neg:watermark`, `lora:detail -model:sdxl`). Matches are highlighted in the prompts, and folder
counts in the tree follow the search.

The index is built in the main process after each scan and cached in `<userData>/search-index.json` by path, mtime
and size, so only new or changed files are re-read. Bump `INDEX_VERSION` in `src/main/indexer.ts` when the parser
changes what goes into the index.

## Thumbnails

The grid loads `aiv://thumb/<path>?v=<mtime>-<size>`. On a miss (404) the cell asks a pool of Web Workers to decode
the original with `createImageBitmap`, shrink it to 400 px on the long side and encode WebP; the result is shown at once
and saved by the main process to `<userData>/thumbs/<sha1>.webp`. Newest requests run first and jobs for cells that
scrolled away are dropped. A changed file gets a new key. The ⋯ menu shows the cache size and can remove unused thumbnails (not matching any
file in the open folders) or clear the whole cache.

## Keys

Arrows — move · Enter/Space — fullscreen · Esc — close / clear selection · drag an image out — drop into ComfyUI.
Ctrl/Cmd+click — add to selection · Shift+click — range · Ctrl/Cmd+A — select all · F — toggle favorite for the selection.

Favorites are stored as absolute paths in `<userData>/favorites.json` (on Linux `~/.config/aiimageviewer/`).
