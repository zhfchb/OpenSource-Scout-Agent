"""Development-only browser verification; uses bundled Python Playwright."""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

def settled(page):
    try:
        page.wait_for_load_state('networkidle', timeout=3000)
    except PlaywrightTimeout:
        # Edge on this host keeps networkidle pending; visible DOM assertions
        # below provide the actual readiness checks instead of a fixed sleep.
        pass

out = Path('data/browser-evidence')
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get('SCOUT_BROWSER_CHANNEL', 'msedge'))
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:3107')
    settled(page)
    page.get_by_role('heading', name='回到工作台').wait_for()
    page.screenshot(path=str(out / 'login.png'), full_page=True)
    page.get_by_label('管理员密码').fill('browser-fixture-only')
    page.get_by_role('button', name='进入工作台').click()
    page.get_by_role('heading', name='贡献，从理解问题开始').wait_for()
    assert page.get_by_role('button', name='添加 GitHub Issue').is_disabled()
    page.screenshot(path=str(out / 'tasks.png'), full_page=True)
    page.get_by_role('button', name='设置与限额').click()
    page.get_by_label('模型标识').fill('browser-fixture-model')
    page.get_by_role('button', name='保存设置').click()
    page.get_by_role('status').filter(has_text='设置已保存').wait_for()
    page.reload()
    settled(page)
    page.get_by_role('button', name='设置与限额').click()
    assert page.get_by_label('模型标识').input_value() == 'browser-fixture-model'
    page.screenshot(path=str(out / 'settings.png'), full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.screenshot(path=str(out / 'mobile.png'), full_page=True)
    page.get_by_role('button', name='退出登录').click()
    page.get_by_role('heading', name='回到工作台').wait_for()
    page.reload()
    page.get_by_role('heading', name='回到工作台').wait_for()
    assert errors == [], errors
    browser.close()
print('PASS: login, task skeleton, settings persistence, mobile overflow, logout; no page errors')
