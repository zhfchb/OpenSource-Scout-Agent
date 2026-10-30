"""Guest and owner publication flows against the explicit FIXTURE server on 3110."""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright, expect
out = Path('data/browser-evidence/M3')
out.mkdir(parents=True, exist_ok=True)
base = 'http://127.0.0.1:3110'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get('SCOUT_BROWSER_CHANNEL', 'msedge'))
    owner = browser.new_context(viewport={"width": 1440, "height": 1050}, reduced_motion='reduce')
    page = owner.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base)
    page.get_by_role('heading', name='还没有公开报告').wait_for()
    page.get_by_role('button', name='管理员登录', exact=False).click()
    page.get_by_label('管理员密码').fill('browser-fixture-only')
    page.get_by_role('button', name='进入工作台').click()
    page.locator('aside nav button').nth(1).click()
    page.get_by_label('GitHub 仓库或 Issue 链接').fill('https://github.com/fixture/repo/issues/1')
    page.get_by_role('button', name='解析链接').click()
    page.get_by_role('button', name='开始分析').click()
    page.get_by_label('公开标题').fill('浏览器发布检查 · FIXTURE')
    raw = r'有限源码分析 <img src=x onerror=alert(1)> sk-publicfixture012345 C:\Users\private\token.txt mail@example.test https://evil.test/?token=hidden'
    page.get_by_label('公开分析摘要').fill(raw)
    page.get_by_role('button', name='生成脱敏预览', exact=True).click()
    public_preview = page.locator('.public-preview pre')
    public_preview.wait_for()
    for forbidden in ['sk-publicfixture012345', 'C:\\Users', 'mail@example.test', 'evil.test']:
        assert forbidden not in public_preview.inner_text()
    publish = page.get_by_role('button', name='确认发布公开报告', exact=True)
    expect(publish).to_be_disabled()
    page.get_by_label('我已核对全部脱敏内容，同意向游客公开此快照').check()
    expect(publish).to_be_enabled()
    page.get_by_label('公开分析摘要').fill(raw + ' 仍需人工核查')
    expect(publish).to_be_disabled()
    page.get_by_role('button', name='生成脱敏预览', exact=True).click()
    page.get_by_label('我已核对全部脱敏内容，同意向游客公开此快照').check()
    expect(publish).to_be_enabled()
    publish.click()
    public_link = page.get_by_role('link', name='查看公开报告', exact=False)
    public_link.wait_for()
    report_path = public_link.get_attribute('href')
    report_id = report_path.split('/')[-1]
    page.locator('.publication-panel').screenshot(path=str(out / 'owner-publication.png'))
    visitor = browser.new_context(viewport={"width": 1440, "height": 1050}, reduced_motion='reduce')
    guest = visitor.new_page()
    guest.on('pageerror', lambda error: errors.append(str(error)))
    guest.goto(base + '/' + report_path)
    guest.get_by_role('heading', name='浏览器发布检查 · FIXTURE').wait_for()
    assert guest.locator('.public-article img').count() == 0
    assert '<img src=x onerror=alert(1)>' in guest.locator('.report-prose').first.inner_text()
    content = guest.locator('.public-article').inner_text()
    for forbidden in ['sk-publicfixture012345', 'C:\\Users', 'mail@example.test', 'evil.test', 'MODEL_API_KEY', 'config_snapshot']:
        assert forbidden not in content
    assert visitor.request.get(base + '/api/admin/tasks').status == 401
    assert visitor.request.get(base + '/api/admin/operations').status == 401
    guest.screenshot(path=str(out / 'guest-report.png'), full_page=True)
    guest.goto(base + '/#/reports')
    guest.locator('.report-card').first.wait_for()
    guest.screenshot(path=str(out / 'guest-home.png'), full_page=True)
    guest.set_viewport_size({"width": 390, "height": 844})
    assert guest.evaluate('document.documentElement.scrollWidth <= innerWidth')
    guest.screenshot(path=str(out / 'guest-mobile.png'), full_page=True)
    page.reload()
    page.locator('.task-card').first.click()
    page.get_by_role('button', name='撤回公开报告').click()
    page.get_by_text('新读取已阻止', exact=False).wait_for()
    assert visitor.request.get(base + '/api/public/reports/' + report_id).status == 404
    guest.goto(base + '/' + report_path)
    guest.get_by_role('heading', name='这份报告暂不可读').wait_for()
    guest.goto(base + '/#/reports')
    guest.get_by_role('heading', name='还没有公开报告').wait_for()
    page.get_by_role('button', name='设置').click()
    page.get_by_role('heading', name='存储与运行状态').wait_for()
    page.get_by_role('button', name='清理过期会话与发布预览').click()
    page.get_by_text('没有删除任务、审核包或公开历史', exact=False).wait_for()
    page.get_by_role('button', name='退出登录').click()
    page.get_by_role('heading', name='回到工作台').wait_for()
    assert errors == [], errors
    owner.close()
    visitor.close()
    browser.close()
print('PASS: guest landing/list/detail, owner preview/consent/publication, sensitive redaction, plain-text HTML, guest auth, revocation, mobile, operations, logout')
