"""M2 review workflow against explicit FIXTURE server on port 3109."""
from pathlib import Path
import os
import json
import hashlib
from playwright.sync_api import sync_playwright, expect

out = Path('data/browser-evidence/M2')
out.mkdir(parents=True, exist_ok=True)
base = 'http://127.0.0.1:3109'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel=os.environ.get('SCOUT_BROWSER_CHANNEL', 'msedge'))
    page = browser.new_page(viewport={"width": 1440, "height": 1100}, reduced_motion='reduce', accept_downloads=True)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base + '/#/login')
    page.get_by_label('管理员密码').fill('browser-fixture-only')
    page.get_by_role('button', name='进入工作台').click()
    page.locator('aside nav button').nth(1).click()
    page.get_by_label('GitHub 仓库或 Issue 链接').fill('https://github.com/fixture/repo/issues/1')
    page.get_by_role('button', name='解析链接').click()
    page.get_by_role('button', name='开始分析').click()
    page.get_by_role('heading', name='确认修改计划').wait_for()
    page.get_by_role('button', name='保存计划', exact=True).click()
    confirm = page.get_by_role('button', name='确认当前 Commit 和计划', exact=True)
    generate = page.get_by_role('button', name='生成一版待验证补丁', exact=True)
    expect(confirm).to_be_enabled()
    expect(generate).to_be_disabled()
    confirm.click()
    expect(generate).to_be_enabled()
    page.get_by_label('修改步骤（每行一条）').fill('建议增加边界校验，并人工核查结果')
    expect(generate).to_be_disabled()
    page.get_by_role('button', name='保存新版本（旧确认失效）', exact=True).click()
    page.get_by_text('版本 2', exact=True).wait_for()
    expect(generate).to_be_disabled()
    confirm.click()
    expect(generate).to_be_enabled()
    page.locator('.patch-review').first.screenshot(path=str(out / 'confirmed-plan.png'))
    generate.click()
    page.get_by_role('heading', name='补丁审核包').wait_for()
    expect(generate).to_be_disabled()
    task_id = page.request.get(base + '/api/admin/tasks').json()['items'][0]['id']
    detail = page.request.get(base + '/api/admin/tasks/' + task_id).json()
    artifact = detail['artifact']
    assert detail['status'] == 'COMPLETED'
    assert len(detail['usage']) == 2
    assert artifact['bundle']['source'] == 'FIXTURE'
    download_url = base + f"/api/admin/tasks/{task_id}/artifacts/{artifact['id']}/download?format=bundle"
    for text, filename in [('下载审核包 JSON', 'review.json'), ('下载 UNVERIFIED.patch', 'change.patch'), ('下载 PR 草稿', 'pr.md')]:
        with page.expect_download() as download_event:
            page.get_by_role('link', name=text, exact=False).click()
        download = download_event.value
        assert 'UNVERIFIED' in download.suggested_filename
        download.save_as(str(out / filename))
    package = json.loads((out / 'review.json').read_text(encoding='utf8'))
    assert hashlib.sha256((out / 'review.json').read_bytes()).hexdigest() == artifact['hash']
    assert package['patchStatus'] == 'UNVERIFIED'
    assert package['projectTests'] == 'NOT_RUN'
    assert (out / 'change.patch').read_text(encoding='utf8') == package['patch']['diff']
    page.get_by_role('button', name='记录为已人工审核').click()
    page.get_by_text('人工审核 已审核', exact=False).wait_for()
    page.get_by_label('手工 PR 链接').fill('https://github.com/fixture/repo/pull/123')
    page.get_by_role('button', name='保存手工 PR 记录', exact=True).click()
    page.get_by_text('手动记录 · 开放中', exact=False).wait_for()
    page.locator('.patch-review').nth(1).screenshot(path=str(out / 'review-artifact.png'))
    page.reload()
    page.locator('.task-card').first.click()
    page.get_by_role('heading', name='补丁审核包').wait_for()
    page.get_by_text('人工审核 已审核', exact=False).wait_for()
    assert page.locator('.detail-column img').count() == 0
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.locator('.patch-review').first.screenshot(path=str(out / 'plan-mobile.png'))
    page.get_by_role('button', name='拒绝此审核包').click()
    expect(page.get_by_role('link', name='下载审核包 JSON', exact=False)).to_have_count(0)
    assert page.request.get(download_url).status == 409
    page.get_by_role('button', name='退出登录').click()
    page.get_by_role('heading', name='欢迎回来').wait_for()
    assert page.request.get(download_url).status == 401
    assert errors == [], errors
    browser.close()
print('PASS: plan save/revision/confirmation, one patch, 3 downloads with matching SHA-256, manual review and PR, reload, mobile, rejection, auth')
