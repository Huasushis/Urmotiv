import { expect, test } from '@playwright/test';

test('切换用户后仅使用目标权限，持续提示身份，退出后需重新登录', async ({page}, testInfo) => {
  const origin = 'http://localhost:5173';
  await page.goto('/demo-login');
  await page.getByRole('button', {name: /系统管理员/}).click();
  await expect(page).toHaveURL(/\/problems$/);
  const actor = await page.request.get('/api/v1/session').then(r => r.json());
  const path = '/api/v1/admin/users/' + actor.user.id + '/permissions';
  const before = await page.request.get(path).then(r => r.json());
  const grant = await page.request.put(path, {headers: {origin}, data: {
    expectedRevision: before.delta.revision,
    allows: [...new Set([...before.delta.allows, 'user.impersonate'])], denies: before.delta.denies
  }});
  expect(grant.ok()).toBe(true);
  try {
    await page.goto('/admin/users');
    await page.locator('.permission-user-select').filter({hasText: '投稿人演示账号'}).click();
    const target = await page.request.get('/api/v1/admin/users?search=' + encodeURIComponent('投稿人演示账号')).then(r => r.json());
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', {name: '切换到此用户', exact: true}).click();
    await expect(page).toHaveURL(/\/problems$/);
    const notice = page.getByRole('complementary', {name: '当前切换身份'});
    await expect(notice).toContainText('投稿人演示账号');
    await expect(notice).toContainText('需要重新登录');
    const current = await page.request.get('/api/v1/session').then(r => r.json());
    expect(current.user.id).toBe(target.items[0].id);
    expect(current.user.isRoot).toBe(false);
    expect(current.user.permissions).not.toContain('system.manage');
    expect(current.identity.switched).toBe(true);
    expect((await page.request.get('/api/v1/admin/users')).status()).toBe(404);
    expect((await page.request.get('/api/v1/me/security').then(r=>r.json())).canChangeCredentials).toBe(false);
    await page.reload();
    await expect(notice).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({path:testInfo.outputPath('switched-user.png'), fullPage:true});
    await page.getByRole('button', {name: '退出并重新登录', exact:true}).click();
    await expect(page).toHaveURL(/\/login$/);
    expect((await page.request.get('/api/v1/session').then(r=>r.json())).user).toBeNull();
    expect((await page.request.get('/api/v1/me')).status()).toBe(401);
  } finally {
    // 真正重新认证后恢复合成管理员的原授权，不能靠退出切换恢复旧权限。
    await page.goto('/demo-login');
    await page.getByRole('button', {name:/系统管理员/}).click();
    await expect(page).toHaveURL(/\/problems$/);
    const latest = await page.request.get(path).then(r=>r.json());
    const restored = await page.request.put(path,{headers:{origin},data:{expectedRevision:latest.delta.revision,allows:before.delta.allows,denies:before.delta.denies}});
    expect(restored.ok()).toBe(true);
  }
});
