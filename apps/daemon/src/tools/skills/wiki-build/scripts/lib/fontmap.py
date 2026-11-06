#!/usr/bin/env python3
"""Detect and repair a broken-font text layer — the "electronic PDF that lies".

Why this exists: an electronic PDF is usually the fast path (no OCR), but some
Chinese typesetting tools (方正书版 and friends) embed a handful of SUBSET fonts
whose ToUnicode map is broken. The damage is that mathematical italic letters
come out as unrelated Han characters:

    A → 犃     a → 犪     x → 狓     e₁ → 犲１
    →  ⊂  ⇒  ∅  √  ∥  … land in the private-use area

The extracted text is the right LENGTH and looks like Chinese, so a builder who
trusts it produces a whole book of subtly wrong pages without ever noticing.
Measured on 人教A版必修第二册: 107 broken glyphs, 22,959 occurrences.

Four steps, and the third one is the one people skip:

  1. scan   — find the suspects by FONT, not by character (see is_suspect)
  2. dump   — crop each broken glyph to a zoomed PNG for a human to look at
  3. LOOK   — actually open those crops. 'This glyph is a' is not derivable
              from context. Guessing one letter wrong corrupts every formula
              on every page that uses it.
  4. clean  — apply the map, emit a page-marked markdown for prep.mjs

    python scripts/lib/fontmap.py scan  <pdf> [--pages 1-40]
    python scripts/lib/fontmap.py dump  <pdf> <outdir> [--pages 1-40]
    python scripts/lib/fontmap.py clean <pdf> <out.md> --map map.json [--offset 5]

`scan` and `dump` print a JSON object as the LAST line of stdout.

Reuse: the same publisher's books share the font set, so a map built for one
volume usually applies verbatim to its siblings — try that before re-deriving.
See the wiki-build SKILL's 「电子版坏字体文字层」 section.
"""
import json
import os
import re
import sys

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.stderr.write(
        "PyMuPDF not installed. Install with:\n"
        "  pip install pymupdf -i https://pypi.tuna.tsinghua.edu.cn/simple\n"
    )
    sys.exit(2)

# Names seen in the wild. The heuristic below catches these anyway; the list is
# a fast path and a hint for a human reading the report.
KNOWN_BROKEN = re.compile(r"^(E-BX9|E-HX9|E-HZ9|O9-|FzBookMaker)", re.I)

# The reliable, language-independent signal: a broken subset emits glyphs that
# NO other font in the document emits. 分 is rendered by the heading fonts AND
# by the body font, so it is text; 犪 is rendered only by the math-italic subset,
# so it is a broken glyph wearing a Han codepoint.
#
# A naive "this font has few glyphs" test looks tempting and is WRONG: on a
# small page sample a legitimate heading font also shows only a few dozen
# characters, and the test then reports ordinary Chinese (分, 的, 平面) as
# broken. Coverage matters — scan the whole document, not a handful of pages.
UNIQUE_SHARE = 0.8

CTRL_RE = re.compile("[\x00-\x08\x0b-\x1f]")
# Figure annotations use a bracket-pair glyph; a clean map can carry it, but
# these two are unambiguous enough to hard-code.
BRACKETS = {"὆": "（", "὇": "）"}


def is_han(ch):
    return "一" <= ch <= "鿿"


def collect_font_chars(doc, pages):
    """font name → Counter of the characters it renders."""
    from collections import Counter

    per_font = {}
    for idx in pages:
        for block in doc[idx].get_text("rawdict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    counts = per_font.setdefault(span["font"], Counter())
                    for ch in span.get("chars", []):
                        counts[ch["c"]] += 1
    return per_font


def suspect_fonts(per_font):
    """Fonts whose glyph inventory looks like a broken subset.

    A font qualifies when it carries Han AND its characters are (almost) all
    exclusive to it — i.e. no other font in the document renders them. The
    KNOWN_BROKEN name match short-circuits that for fonts seen in the wild.
    """
    # How many fonts render each character.
    foes = {}
    for counts in per_font.values():
        for c in counts:
            foes[c] = foes.get(c, 0) + 1

    out = {}
    for font, counts in per_font.items():
        if not any(is_han(c) for c in counts):
            continue
        if KNOWN_BROKEN.match(font) and len(counts) <= 400:
            out[font] = counts
            continue
        exclusive = sum(1 for c in counts if foes[c] == 1)
        if len(counts) and exclusive / len(counts) >= UNIQUE_SHARE:
            out[font] = counts
    return out


def page_spec(spec, page_count):
    if not spec:
        return list(range(page_count))
    out = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            try:
                lo, hi = int(a), int(b)
            except ValueError:
                continue
            out += [n - 1 for n in range(lo, hi + 1) if 1 <= n <= page_count]
        else:
            try:
                n = int(part)
            except ValueError:
                continue
            if 1 <= n <= page_count:
                out.append(n - 1)
    return sorted(set(out))


def find_examples(doc, pages, wanted, limit=3):
    """codepoint → up to `limit` context strings, for identification."""
    ctx = {}
    for idx in pages:
        for block in doc[idx].get_text("rawdict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                text = "".join(c["c"] for span in line["spans"] for c in span.get("chars", []))
                for i, ch in enumerate(text):
                    if ch in wanted:
                        bucket = ctx.setdefault(ch, [])
                        if len(bucket) < limit:
                            bucket.append(text[max(0, i - 14):i] + "【" + ch + "】" + text[i + 1:i + 15])
    return ctx


def classify(ch):
    """What the operator has to do about one suspect character.

    The suspect fonts also emit perfectly ordinary fullwidth punctuation and
    standard maths symbols (≤ ∑ ∈ ×). Reporting those alongside the genuinely
    broken glyphs buries the ~50 lines that actually need a decision.
    """
    o = ord(ch)
    if 0xE000 <= o <= 0xF8FF:
        return "needMap"            # 私用区：只能靠裁图辨认
    if is_han(ch):
        return "needMap"            # 被坏字体当作字母用的汉字码位
    if 0xFF01 <= o <= 0xFF5E or ch == "　":
        return "autoHandled"        # clean 自动转半角/空格
    return "alreadyFine"            # 本来就是合法 Unicode（≤ ∑ ∈ × …）


def cmd_scan(args):
    pdf = args[0]
    spec = args[args.index("--pages") + 1] if "--pages" in args else None
    doc = fitz.open(pdf)
    pages = page_spec(spec, doc.page_count)
    per_font = collect_font_chars(doc, pages)
    suspects = suspect_fonts(per_font)

    chars = {}
    for counts in suspects.values():
        for c, n in counts.items():
            chars[c] = chars.get(c, 0) + n
    ctx = find_examples(doc, pages, set(chars))

    sys.stderr.write("[fontmap] %s：页数 %d，扫描 %d 页\n" % (os.path.basename(pdf), doc.page_count, len(pages)))
    for font, counts in sorted(suspects.items(), key=lambda kv: -sum(kv[1].values())):
        cjk = [c for c in counts if is_han(c)]
        sys.stderr.write("  坏字体 %-42s 字形 %3d（含汉字 %3d）\n" % (font[:42], len(counts), len(cjk)))
    buckets = {"needMap": [], "autoHandled": [], "alreadyFine": []}
    for c, n in chars.items():
        buckets[classify(c)].append((c, n))

    sys.stderr.write("  合计可疑字形 %d 个、%d 处\n" % (len(chars), sum(chars.values())))
    sys.stderr.write("    需要人工定映射 %d 个（私用区 + 被当字母用的汉字码位）\n" % len(buckets["needMap"]))
    sys.stderr.write("    clean 自动处理 %d 个（全角标点/空格）· 本来就合法 %d 个（≤ ∑ ∈ × …）\n"
                     % (len(buckets["autoHandled"]), len(buckets["alreadyFine"])))
    if not buckets["needMap"]:
        sys.stderr.write("  未发现需要人工处理的坏字——文字层可用，直接抽文字即可。\n")
    else:
        sys.stderr.write("  下一步：fontmap.py dump <pdf> <outdir> 导出字形裁图，逐个看过再定映射。\n")
        for c, n in sorted(buckets["needMap"], key=lambda kv: -kv[1])[:12]:
            sys.stderr.write("    U+%04X x%-5d %s\n" % (ord(c), n, " | ".join(ctx.get(c, []))[:96]))

    print(json.dumps({
        "pdf": pdf, "pages": doc.page_count, "scanned": len(pages),
        "suspectFonts": sorted(suspects),
        "needMap": {("U+%04X" % ord(c)): n for c, n in sorted(buckets["needMap"], key=lambda kv: -kv[1])},
        "autoHandled": len(buckets["autoHandled"]),
        "alreadyFine": len(buckets["alreadyFine"]),
    }, ensure_ascii=False))
    return 0


def cmd_dump(args):
    pdf, outdir = args[0], args[1]
    spec = args[args.index("--pages") + 1] if "--pages" in args else None
    try:
        from PIL import Image
    except ImportError:
        sys.stderr.write("PIL not installed. Install with:\n"
                         "  pip install pillow -i https://pypi.tuna.tsinghua.edu.cn/simple\n")
        return 2

    doc = fitz.open(pdf)
    pages = page_spec(spec, doc.page_count)
    suspects = suspect_fonts(collect_font_chars(doc, pages))
    os.makedirs(outdir, exist_ok=True)

    first = {}   # char → (page_idx, bbox) of its first occurrence
    for idx in pages:
        for block in doc[idx].get_text("rawdict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    if span["font"] not in suspects:
                        continue
                    for ch in span.get("chars", []):
                        first.setdefault(ch["c"], (idx, ch["bbox"]))

    zoom = 8
    written = []
    for c, (idx, bbox) in sorted(first.items()):
        clip = fitz.Rect(bbox[0] - 1, bbox[1] - 1, bbox[2] + 1, bbox[3] + 1)
        pix = doc[idx].get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=clip)
        name = "U+%04X.png" % ord(c)
        Image.frombytes("RGB", (pix.width, pix.height), pix.samples).save(os.path.join(outdir, name))
        written.append(name)

    sys.stderr.write("[fontmap] 导出 %d 个字形裁图 → %s\n" % (len(written), outdir))
    sys.stderr.write("  请逐个打开辨认（放大拼成一张联络图更省事），再写出 map.json：\n")
    sys.stderr.write('    { "犃": "A", "犪": "a", "狓": "x", ... }\n')
    print(json.dumps(written, ensure_ascii=False))
    return 0


def cmd_clean(args):
    pdf, out = args[0], args[1]
    map_path = args[args.index("--map") + 1] if "--map" in args else None
    offset = int(args[args.index("--offset") + 1]) if "--offset" in args else 0

    mapping = {}
    if map_path:
        raw = json.load(open(map_path, encoding="utf-8"))
        mapping = {k: v for k, v in raw.items() if isinstance(k, str) and len(k) == 1}

    full = {chr(o): chr(o - 0xFEE0) for o in range(0xFF01, 0xFF5F)}   # 全角 ASCII → 半角

    def clean(text, suspect):
        out_chars = []
        for ch in text:
            if suspect and ch in mapping:
                out_chars.append(mapping[ch])
            elif ch in full:
                out_chars.append(full[ch])
            elif ch == "　":
                out_chars.append(" ")
            elif suspect and ch in BRACKETS:
                out_chars.append(BRACKETS[ch])
            elif suspect and 0xE000 <= ord(ch) <= 0xF8FF:
                out_chars.append("〓")     # 未识别私用字，显式标出来
            else:
                out_chars.append(ch)
        return CTRL_RE.sub("", "".join(out_chars))

    doc = fitz.open(pdf)
    suspects = suspect_fonts(collect_font_chars(doc, range(doc.page_count)))
    residual = 0
    with open(out, "w", encoding="utf-8") as fh:
        for i in range(doc.page_count):
            label = ("教材第%d页 (PDF %d)" % (i + 1 - offset, i + 1)) if offset else ("PDF第%d页" % (i + 1))
            fh.write("\n@@@@@ %s @@@@@\n" % label)
            # The same Unicode character can be a broken math glyph in one
            # font and legitimate prose in another. Preserve that provenance.
            for block in doc[i].get_text("rawdict")["blocks"]:
                if block.get("type") != 0:
                    continue
                for line in block["lines"]:
                    for span in line["spans"]:
                        suspect = span["font"] in suspects
                        text = clean("".join(ch["c"] for ch in span.get("chars", [])), suspect)
                        fh.write(text)
                        if suspect:
                            residual += sum(1 for ch in text if 0x7200 <= ord(ch) <= 0x74FF or ch == "〓")
                    fh.write("\n")
    sys.stderr.write("[fontmap] 写出 %s（%d 页）\n" % (out, doc.page_count))
    sys.stderr.write("  映射表 %d 条；残留可疑字符 %d 处（多落在图内部，属正常）\n" % (len(mapping), residual))
    print(json.dumps({"out": out, "mapEntries": len(mapping), "residual": residual}, ensure_ascii=False))
    return 0


def main():
    if len(sys.argv) < 3:
        sys.stderr.write(__doc__.split("Four steps")[1].split("\n\n")[0].strip() + "\n")
        return 1
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "scan":
        return cmd_scan(args)
    if cmd == "dump":
        return cmd_dump(args)
    if cmd == "clean":
        return cmd_clean(args)
    sys.stderr.write("unknown command: %s (expected scan | dump | clean)\n" % cmd)
    return 1


if __name__ == "__main__":
    sys.exit(main())
