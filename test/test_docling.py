"""
Docling 转换效果测试脚本
- 对 test/ 下的三个文件分别转换
- 输出 markdown 到 test/output/
- 记录耗时、输出大小
"""
import os
import sys
import time
from pathlib import Path

# 把 Python 用户 Scripts 加到 PATH（docling.exe 在那里）
user_scripts = Path(os.environ["USERPROFILE"]) / "AppData/Roaming/Python/Python313/Scripts"
if str(user_scripts) not in os.environ.get("PATH", ""):
    os.environ["PATH"] = str(user_scripts) + os.pathsep + os.environ.get("PATH", "")

from docling.document_converter import DocumentConverter

HERE = Path(__file__).parent
OUTPUT = HERE / "output"
OUTPUT.mkdir(exist_ok=True)

FILES = [
    "市域铁路供电检修上岗培训教案-变配电实训.docx",
    "智慧工地2.0平台方案汇报0529.pptx",
    "计算机行业深度报告 解析大模型行业：从发展历程到投资视角 .pdf",
]


def main():
    print(f"[init] DocumentConverter loading ...")
    t0 = time.time()
    converter = DocumentConverter()
    print(f"[init] ready in {time.time() - t0:.2f}s\n")

    results = []
    for name in FILES:
        src = HERE / name
        if not src.exists():
            print(f"[skip] {name} (not found)")
            continue

        print(f"[run] {name} ({src.stat().st_size / 1024:.1f} KB)")
        t1 = time.time()
        try:
            result = converter.convert(src)
            md = result.document.export_to_markdown()
            elapsed = time.time() - t1
            out_path = OUTPUT / (src.stem + ".md")
            out_path.write_text(md, encoding="utf-8")
            print(f"  -> {out_path.name} ({len(md)} chars, {elapsed:.2f}s)")
            results.append((name, "OK", len(md), elapsed, out_path))
        except Exception as e:
            elapsed = time.time() - t1
            print(f"  -> ERROR ({elapsed:.2f}s): {type(e).__name__}: {e}")
            results.append((name, "FAIL", 0, elapsed, str(e)))

    print("\n=== SUMMARY ===")
    print(f"{'file':<55} {'status':<5} {'chars':>7} {'time':>7}")
    print("-" * 80)
    for name, status, chars, elapsed, _ in results:
        print(f"{name[:52]:<55} {status:<5} {chars:>7} {elapsed:>6.2f}s")


if __name__ == "__main__":
    main()
