# Docling CLI Reference

Complete CLI options for docling.

## Input/Output Formats

### `--from`
Input format. Options: `docx`, `pptx`, `html`, `image`, `pdf`, `asciidoc`, `md`, `csv`, `xlsx`, `xml_uspto`, `xml_jats`, `mets_gbs`, `json_docling`, `audio`, `vtt`, `latex`

Default: all formats (auto-detect)

### `--to`
Output format. Options: `md`, `json`, `yaml`, `html`, `html_split_page`, `text`, `doctags`

Default: `md` (Markdown)

### `--output`
Output directory path.

Default: current directory (`.`)

## Processing Options

### `--device`
Accelerator device. Options: `auto`, `cpu`, `cuda`, `mps`, `xpu`

Default: `auto`

### `--ocr` / `--no-ocr`
Enable OCR for bitmap content.

Default: `True`

### `--force-ocr` / `--no-force-ocr`
Replace existing text with OCR.

Default: `False`

### `--tables` / `--no-tables`
Extract table structure.

Default: `True`

### `--table-mode`
Table extraction mode: `fast` or `accurate`

Default: `accurate`

### `--ocr-engine`
OCR engine: `auto`, `easyocr`, `ocrmac`, `rapidocr`, `tesserocr`, `tesseract`

Default: `auto`

### `--ocr-lang`
Comma-separated language codes for OCR.

Example: `--ocr-lang en,pt`

## PDF Options

### `--pdf-backend`
PDF backend: `pypdfium2`, `dlparse_v1`, `dlparse_v2`, `dlparse_v4`

Default: `dlparse_v4`

### `--pdf-password`
Password for protected PDFs.

### `--page-batch-size`
Pages processed per batch.

Default: `4`

## Pipeline Options

### `--pipeline`
Processing pipeline: `legacy`, `standard`, `vlm`, `asr`

Default: `standard`

### `--vlm-model`
Vision-Language Model preset for PDFs/images. Options: `smoldocling`, `granite_docling`, `deepseek_ocr`, `granite_vision`, `pixtral`, `got_ocr`, `phi4`, `qwen`, `gemma_12b`, `gemma_27b`, `dolphin`

Default: `granite_docling`

### `--asr-model`
ASR model for audio/video. Options: `whisper_tiny`, `whisper_small`, `whisper_medium`, `whisper_base`, `whisper_large`, `whisper_turbo`, and `_mlx`/`_native` variants.

Default: `whisper_tiny`

## Enrichment Options

### `--enrich-code`
Enable code enrichment model.

Default: `False`

### `--enrich-formula`
Enable formula enrichment model.

Default: `False`

### `--enrich-picture-classes`
Enable picture classification.

Default: `False`

### `--enrich-picture-description`
Enable picture description model.

Default: `False`

### `--enrich-chart-extraction`
Convert bar/pie/line charts to tables.

Default: `False`

## HTTP Options

### `--headers`
JSON string of HTTP headers for URL fetching.

Example: `--headers '{"User-Agent": "Mozilla/5.0"}'`

## Output Options

### `--image-export-mode`
Image handling: `placeholder`, `embedded`, `referenced`

Default: `embedded`

### `--show-layout`
Show bounding boxes on page images.

Default: `False`

## Debug Options

### `--verbose` / `-v`
Verbosity level. `-v` for info, `-vv` for debug.

### `--debug-visualize-cells`
Visualize PDF cells.

### `--debug-visualize-ocr`
Visualize OCR cells.

### `--debug-visualize-layout`
Visualize layout clusters.

### `--debug-visualize-tables`
Visualize table cells.

### `--profiling`
Summarize profiling details.

### `--save-profiling`
Save profiling to JSON.

## Other Options

### `--document-timeout`
Timeout per document (seconds).

### `--num-threads`
Number of threads.

Default: `4`

### `--abort-on-error`
Abort on first error.

Default: `False`

### `--artifacts-path`
Location of model artifacts.

### `--enable-remote-services`
Enable remote model services.

Default: `False`

### `--allow-external-plugins`
Load third-party plugins.

Default: `False`

### `--version`
Show version info.

### `--help`
Show help message.
