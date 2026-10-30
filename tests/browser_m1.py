"""M1 browser integration using an explicitly labelled server fixture on 3108."""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright

out = Path('data/browser-evidence/M1')
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get('SCOUT_BROWSER_CHANNEL', 'msedge'))
    page = browser.new_page(viewport={"width": 1440, "height": 1100}, reduced_motion='reduce')
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:3108/#/login')
    page.get_by_label('管理员密码').fill('browser-fixture-only')
    page.get_by_role('button', name='进入工作台').click()
    page.locator('aside nav button').nth(1).click()
    page.get_by_label('GitHub 仓库或 Issue 链接').fill('https://github.com/fixture/repo/issues/1')
    page.get_by_role('button', name='解析链接').click()
    page.get_by_role('button', name='开始分析').click()
    page.get_by_role('heading', name='问题分析').wait_for()
    assert page.get_by_text('实际 123 Token', exact=False).is_visible()
    assert page.get_by_text('FIXTURE：并非真实 GitHub 或模型调用', exact=False).is_visible()
    assert page.locator('.detail-column img').count() == 0
    assert page.locator('.analysis-text').first.inner_text().endswith('<img src=x onerror=alert(1)>')
    assert page.locator('.task-card').count() == 1
    page.get_by_role('button', name='开始分析').click()
    page.get_by_text('已打开现有任务，本次未重复发起。', exact=False).wait_for()
    assert page.locator('.task-card').count() == 1
    page.screenshot(path=str(out / 'analysis-desktop.png'), full_page=True)
    page.reload()
    page.locator('.task-card').first.click()
    page.get_by_role('heading', name='问题分析').wait_for()
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(out / 'analysis-mobile.png'), full_page=True)
    page.get_by_role('button', name='退出登录').click()
    page.get_by_role('heading', name='回到工作台').wait_for()
    assert errors == [], errors
    browser.close()
print('PASS: fixture task, polling, exact evidence, usage, duplicate click, persisted detail, escaped HTML, mobile, logout')
