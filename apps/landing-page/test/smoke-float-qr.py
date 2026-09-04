# 冒烟测试：file:// 本地打开官网首页，右下角悬浮二维码必须真实渲染。
# 复现并验证 2026-09-04 用户报告的“本地看二维码无法显示”。
import sys
from playwright.sync_api import sync_playwright

# Windows 控制台默认 GBK，避免输出 emoji/非 GBK 字符
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

URL = "file:///D:/work/02-code/Molio/apps/landing-page/index.html"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    failed = []
    page.on("requestfailed", lambda r: failed.append(f"{r.url} -> {r.failure}"))
    page.goto(URL, wait_until="domcontentloaded")
    img = page.wait_for_selector("#molio-floaters img", timeout=10000)
    src = img.get_attribute("src") or ""
    # 等待图片解码完成
    page.wait_for_function(
        "() => { const i = document.querySelector('#molio-floaters img');"
        " return i && i.complete && i.naturalWidth > 0; }",
        timeout=15000,
    )
    info = page.evaluate(
        "() => { const i = document.querySelector('#molio-floaters img');"
        " return { src: i.src, w: i.naturalWidth, h: i.naturalHeight }; }"
    )
    caption = page.locator("#molio-floaters .float-qr-caption").inner_text()
    page.screenshot(path="apps/landing-page/test/smoke-float-qr.png")
    browser.close()

print("img src    :", info["src"])
print("natural    :", info["w"], "x", info["h"])
print("caption    :", caption)
qr_fail = [f for f in failed if "qrcode" in f]
print("qr 请求失败:", qr_fail if qr_fail else "无")

ok = (
    info["src"].startswith("file:///D:/work/02-code/Molio/apps/landing-page/images/")
    and info["w"] > 0
    and not qr_fail
)
print("结果:", "PASS ✅" if ok else "FAIL ❌")
sys.exit(0 if ok else 1)
