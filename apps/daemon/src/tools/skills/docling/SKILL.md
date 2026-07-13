---
name: docling
description: PRIMARY skill for converting .pdf, .docx, .pptx, .xlsx, .doc, .ppt, .xls, images, and audio/video files (.mp3, .wav, .m4a, .mp4, .mov, etc.) to Markdown. Always prefer this over the docx/pdf/pptx/xlsx/paddleocr skills — docling uses GPU-accelerated OCR + layout detection + table structure extraction for documents, and Whisper ASR for speech-to-text on audio/video. Also supports LaTeX and VTT subtitle files.
version: 1.2.0
metadata:
  requires:
    bins: ["docling"]
    python: ">=3.10"
---

# Docling — Local Document → Markdown Converter

CLI tool that uses AI models (layout detection, OCR, table extraction) to convert documents into clean, structured Markdown.

## Supported Formats

**Office**: PDF, DOCX, PPTX, XLSX  
**Images**: PNG, JPG, TIFF (with OCR)  
**Web**: HTML, Markdown  
**Data**: CSV  
**Academic**: LaTeX, XML (USPTO, JATS, METS)  
**Media**: Audio/video transcripts (VTT)  
**Other**: JSON (docling format), ASCIIDoc

## When to Use

| Scenario | Tool |
|----------|------|
| 📄 **PDF / DOCX / PPTX / XLSX on disk** | ✅ **docling** |
| 🖼️ Images with text (OCR) | ✅ **docling** |
| 📊 CSV / Markdown / HTML on disk | ✅ **docling** |
| 🎤 Audio/video transcripts | ✅ **docling** |
| 🌐 Public web page → markdown | ❌ Use `WebFetch` (no install needed) |
| 🔒 Web page requiring login (WeChat, Zhihu, etc.) | ❌ Use `kimi-webbridge` or Chrome extension |
| 🔍 Search for web pages | ❌ Use `WebSearch` |

**Scope boundary**: docling handles **files on disk**. Web content is out of scope — use the right tool for the job.

## Prerequisites

### Install docling

```bash
# China users (recommended) — uses Tsinghua mirror, ~10x faster than default
pip install docling -i https://pypi.tuna.tsinghua.edu.cn/simple

# International users
pip install docling
```

Verify:

```bash
docling --version
```

### ⚠️ First-time PDF usage

The first time you convert a PDF, docling downloads ~500MB of AI models (layout + table structure) to `~/.cache/huggingface/`. Subsequent runs reuse cached models and are much faster.

**For users in China**: set the HuggingFace mirror environment variable **before** first run, otherwise model download will timeout:

```bash
# Linux / macOS / Git Bash
export HF_ENDPOINT=https://hf-mirror.com
docling file.pdf --to md

# Windows CMD
set HF_ENDPOINT=https://hf-mirror.com
docling file.pdf --to md

# Windows PowerShell
$env:HF_ENDPOINT="https://hf-mirror.com"
docling file.pdf --to md
```

**Tip**: If you see connection timeout errors while downloading models, this is almost always the cause.

### ⚠️ First-time audio/video usage

ASR (Whisper) models are **downloaded on demand** — only when you actually convert an audio/video file. Processing PDFs/images does **not** trigger a Whisper download, and vice versa.

- **Location**: same cache as document models, `~/.cache/huggingface/`
- **Size by model**: `whisper_tiny` ~75MB (default), `whisper_small`/`base` ~250-400MB, `whisper_medium` ~1GB, `whisper_large`/`turbo` ~1.5-3GB
- **Reusable**: downloaded once, reused on subsequent runs (no re-download)
- **China users**: the same `HF_ENDPOINT=https://hf-mirror.com` mirror applies — set it before the first audio run, otherwise the download will time out

First run is slow (downloading the model); subsequent runs are pure local inference, speed depends on CPU/GPU.

## Quick Commands

### Document → Markdown (most common)

```bash
# Auto-detect format (PDF, DOCX, PPTX, XLSX, image)
docling "path/to/file.pdf" --to md --output .molio/docling

# Force a specific format when auto-detect fails
docling "file.docx" --from docx --to md --output .molio/docling
docling "slides.pptx" --from pptx --to md --output .molio/docling
docling "report.xlsx" --from xlsx --to md --output .molio/docling
```

Output: creates a `.md` file in the specified output directory. **统一用 `.molio/docling` 作为输出目录**（Molio 工作区，文件树扫描会跳过，不污染 vault 根）。

### PDF with specific options

```bash
# PDF with OCR (for scanned documents)
docling "scanned.pdf" --ocr --to md --output .molio/docling

# Use pypdfium2 backend (fallback when default parser fails)
docling "problem.pdf" --pdf-backend pypdfium2 --to md --output .molio/docling

# Force OCR even if text layer exists
docling "mixed.pdf" --force-ocr --to md --output .molio/docling
```

### OCR on images

```bash
docling "screenshot.png" --from image --to md --output .molio/docling
docling "photo.jpg" --from image --ocr --to md --output .molio/docling
```

### Audio / Video → Markdown (speech-to-text)

Uses Whisper ASR models to transcribe audio/video files into Markdown.

```bash
# Audio file (default whisper_tiny — fast, lower accuracy)
docling "recording.mp3" --from audio --to md --output .molio/docling

# Video file with a more accurate model
docling "meeting.mp4" --from audio --pipeline asr --asr-model whisper_large --to md --output .molio/docling

# Apple Silicon: use MLX variant for faster local inference
docling "interview.m4a" --from audio --pipeline asr --asr-model whisper_medium_mlx --to md --output .molio/docling

# Parse an existing VTT subtitle file (no ASR, text-only)
docling "captions.vtt" --from vtt --to md --output .molio/docling
```

**Model size guide**:

| Model | Speed | Accuracy | Size | Use case |
|-------|-------|----------|------|----------|
| `whisper_tiny` (default) | ⚡ fastest | low | ~75MB | quick drafts, English-heavy |
| `whisper_small` / `whisper_base` | fast | medium | ~250-400MB | general use |
| `whisper_medium` | medium | good | ~1GB | Chinese / noisy audio |
| `whisper_large` / `whisper_turbo` | slow | best | ~1.5-3GB | high-accuracy transcripts |

Use `_mlx` suffix on Apple Silicon, `_native` for CPU fallback across platforms.

### GPU acceleration

```bash
# Use GPU if available (auto-detects CUDA/MPS)
docling "file.pdf" --device auto --to md

# Force CPU (slower but works everywhere)
docling "file.pdf" --device cpu --to md

# Force CUDA GPU
docling "file.pdf" --device cuda --to md
```

## Key Options

| Option | Values | Description |
|--------|--------|-------------|
| `--from` | `pdf`, `docx`, `pptx`, `xlsx`, `image`, `html`, `md`, `csv`, `audio`, `vtt`, `latex`, `asciidoc`, `xml_uspto`, `xml_jats`, `mets_gbs`, `json_docling` | Input format (default: auto-detect) |
| `--to` | `md`, `text`, `json`, `html` | Output format (default: `md`) |
| `--device` | `auto`, `cpu`, `cuda`, `mps` | Accelerator (default: `auto`) |
| `--pipeline` | `legacy`, `standard`, `vlm`, `asr` | Processing pipeline (default: standard; use `asr` for audio/video) |
| `--asr-model` | `whisper_tiny`, `whisper_small`, `whisper_medium`, `whisper_base`, `whisper_large`, `whisper_turbo` (+ `_mlx`/`_native` variants) | ASR model for audio/video (default: `whisper_tiny`) |
| `--output` | path | Output directory |
| `--ocr` / `--no-ocr` | flag | Enable/disable OCR (default: on) |
| `--pdf-backend` | `dlparse_v4`, `pypdfium2`, `dlparse_v1`, `dlparse_v2` | PDF parser (default: `dlparse_v4`) |
| `--tables` / `--no-tables` | flag | Extract table structure (default: on) |
| `--table-mode` | `fast`, `accurate` | Table extraction quality |

## Troubleshooting

### ❌ Error: `Inconsistent number of pages: N!=-1`

**Cause**: docling's default PDF parser (`docling-parse`) cannot handle certain PDFs (especially scanned documents or those with unusual structure).

**Fix**: Switch to the `pypdfium2` backend:

```bash
docling "problem.pdf" --pdf-backend pypdfium2 --to md --output .molio/docling
```

`pypdfium2` is more tolerant and will usually succeed.

### ❌ Error: `ConnectTimeout` / `huggingface_hub.errors.LocalEntryNotFoundError`

**Cause**: Cannot reach HuggingFace Hub to download models (common in mainland China).

**Fix**: Set the mirror endpoint before running:

```bash
# Set for this session
export HF_ENDPOINT=https://hf-mirror.com   # bash/zsh
set HF_ENDPOINT=https://hf-mirror.com       # CMD
$env:HF_ENDPOINT="https://hf-mirror.com"    # PowerShell

# Then retry
docling "file.pdf" --to md --output .molio/docling
```

**Permanent fix** (recommended for Chinese users): add to shell profile (`~/.bashrc`, `~/.zshrc`, or system env):

```bash
export HF_ENDPOINT=https://hf-mirror.com
```

### ❌ Error: `ModuleNotFoundError: No module named 'docling'`

**Cause**: `docling` not installed, or not in PATH.

**Fix**:

```bash
# Install (China users use Tsinghua mirror for speed)
pip install docling -i https://pypi.tuna.tsinghua.edu.cn/simple
# International users
# pip install docling

# Verify it's installed
python -c "import docling; print('OK')"

# Check if docling.exe is in PATH
which docling           # Linux/macOS/Git Bash
where docling           # CMD
Get-Command docling     # PowerShell
```

Common install locations:
- Windows: `C:\Users\<user>\AppData\Roaming\Python\Python3X\Scripts\docling.exe`
- Linux/macOS: `~/.local/bin/docling`

If installed but not in PATH, use full path or add to PATH.

### ❌ Slow performance

**Cause**: Running on CPU without GPU, or processing many pages.

**Tips**:
- Use `--device cuda` (NVIDIA) or `--device mps` (Apple Silicon) if available
- Reduce `--page-batch-size` for lower memory usage on large PDFs
- For simple text-only PDFs, skip OCR: `--no-ocr`

### ❌ Poor Chinese text extraction

**Tips**:
- Ensure OCR is enabled: `--ocr`
- Specify OCR language: `--ocr-lang ch_sim,en` (Simplified Chinese + English)
- For scanned Chinese PDFs, use `--force-ocr` to override any (possibly wrong) text layer

## Workflow Example

```bash
# 1. Create output directory (Molio 工作区，不污染 vault 根)
mkdir -p .molio/docling

# 2. Set HF mirror if in China (one-time)
export HF_ENDPOINT=https://hf-mirror.com

# 3. Convert document
docling "合同.pdf" --to md --output .molio/docling

# 4. Read the generated markdown
cat .molio/docling/合同.md
```

## Security Notes

⚠️ **Avoid these flags unless you trust the source:**
- `--enable-remote-services` — can send data to remote endpoints
- `--allow-external-plugins` — loads third-party code
- Custom `--headers` with untrusted values — can redirect requests

## Full CLI Reference

See [references/cli-reference.md](references/cli-reference.md) for complete option list (PDF options, VLM models, enrichment features, debug flags, etc.).
