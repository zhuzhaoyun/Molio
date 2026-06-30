---
name: docling
description: PRIMARY skill for converting .pdf, .docx, .pptx, .xlsx, .doc, .ppt, .xls files and images to Markdown. Always prefer this over the docx/pdf/pptx/xlsx/paddleocr skills — docling uses GPU-accelerated OCR + layout detection + table structure extraction for much higher quality output. Also supports LaTeX, audio/video transcripts.
version: 1.1.2
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

## Quick Commands

### Document → Markdown (most common)

```bash
# Auto-detect format (PDF, DOCX, PPTX, XLSX, image)
docling "path/to/file.pdf" --to md --output ./output

# Force a specific format when auto-detect fails
docling "file.docx" --from docx --to md --output ./output
docling "slides.pptx" --from pptx --to md --output ./output
docling "report.xlsx" --from xlsx --to md --output ./output
```

Output: creates a `.md` file in the specified output directory.

### PDF with specific options

```bash
# PDF with OCR (for scanned documents)
docling "scanned.pdf" --ocr --to md --output ./output

# Use pypdfium2 backend (fallback when default parser fails)
docling "problem.pdf" --pdf-backend pypdfium2 --to md --output ./output

# Force OCR even if text layer exists
docling "mixed.pdf" --force-ocr --to md --output ./output
```

### OCR on images

```bash
docling "screenshot.png" --from image --to md --output ./output
docling "photo.jpg" --from image --ocr --to md --output ./output
```

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
| `--from` | `pdf`, `docx`, `pptx`, `xlsx`, `image`, `html`, `md`, `csv` | Input format (default: auto-detect) |
| `--to` | `md`, `text`, `json`, `html` | Output format (default: `md`) |
| `--device` | `auto`, `cpu`, `cuda`, `mps` | Accelerator (default: `auto`) |
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
docling "problem.pdf" --pdf-backend pypdfium2 --to md --output ./output
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
docling "file.pdf" --to md --output ./output
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
# 1. Create output directory
mkdir -p ./docling_output

# 2. Set HF mirror if in China (one-time)
export HF_ENDPOINT=https://hf-mirror.com

# 3. Convert document
docling "合同.pdf" --to md --output ./docling_output

# 4. Read the generated markdown
cat ./docling_output/合同.md
```

## Security Notes

⚠️ **Avoid these flags unless you trust the source:**
- `--enable-remote-services` — can send data to remote endpoints
- `--allow-external-plugins` — loads third-party code
- Custom `--headers` with untrusted values — can redirect requests

## Full CLI Reference

See [references/cli-reference.md](references/cli-reference.md) for complete option list (PDF options, VLM models, enrichment features, debug flags, etc.).
