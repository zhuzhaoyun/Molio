#!/usr/bin/env python3
"""Render PDF pages to PNG — the whole-page fallback for media.mjs.

Called by `media.mjs pages`. Kept as a file (not an inline -c string) so it
can be read, debugged and run by hand:

    python scripts/lib/render-pages.py <pdf> <outdir> <dpi> [pages]

`pages` is optional: "1-20,42" style. Omitted → every page.

Prints a JSON array of the filenames it wrote as the LAST line of stdout, so
the caller can parse it without depending on any other output.

Why this exists: on a scanned textbook the figure IS a region of the page
bitmap. When docling's layout model misses that region (figure fused into body
text, unusual page furniture), the figure is otherwise lost entirely — and for
a math corpus the figure is often the whole point of the page.
"""
import json
import os
import sys

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.stderr.write(
        "PyMuPDF not installed. Install with:\n"
        "  pip install pymupdf -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
    )
    sys.exit(2)


def parse_pages(spec, page_count):
    """'1-20,42' → [0,1,...,19,41] (0-based). None → every page."""
    if spec is None:
        return list(range(page_count))
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            raise ValueError('Empty page range')
        if "-" in part:
            a, _, b = part.partition("-")
            try:
                lo, hi = int(a), int(b)
            except ValueError:
                raise ValueError('Invalid page range: ' + part)
            if not 1 <= lo <= hi <= page_count:
                raise ValueError('Page range outside document: ' + part)
            for n in range(lo, hi + 1):
                if 1 <= n <= page_count:
                    out.append(n - 1)
        else:
            try:
                n = int(part)
            except ValueError:
                raise ValueError('Invalid page: ' + part)
            if not 1 <= n <= page_count:
                raise ValueError('Page outside document: ' + part)
            if 1 <= n <= page_count:
                out.append(n - 1)
    # Dedupe, keep ascending — re-running a page range must be idempotent.
    return sorted(set(out))


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("usage: render-pages.py <pdf> <outdir> <dpi> [pages]\n")
        return 1

    pdf_path, out_dir, dpi = sys.argv[1], sys.argv[2], int(sys.argv[3])
    options = sys.argv[4:]
    force = '--force' in options
    options = [arg for arg in options if arg != '--force']
    page_spec = options[0] if options else None

    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(pdf_path)
    wanted = parse_pages(page_spec, doc.page_count)
    names = ['page-%03d.png' % (idx + 1) for idx in wanted]
    existing = set(os.listdir(out_dir))
    if not wanted:
        raise ValueError('No pages selected')
    if len(existing | set(names)) > 1000:
        raise ValueError('Output directory would exceed 1000 entries; split the collection')
    if not force and existing.intersection(names):
        raise ValueError('Page images already exist; pass --force to overwrite')

    written = []
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)

    for idx in wanted:
        page = doc[idx]
        pix = page.get_pixmap(matrix=mat, alpha=False)
        name = "page-%03d.png" % (idx + 1)
        pix.save(os.path.join(out_dir, name))
        written.append(name)

    doc.close()
    print(json.dumps(written))
    return 0


if __name__ == "__main__":
    sys.exit(main())
