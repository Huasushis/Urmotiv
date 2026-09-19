import { expect, test, type Page } from "@playwright/test";

async function loginAs(page:Page, name:RegExp) {
  await page.goto('/demo-login');
  await page.getByRole('button',{name}).click();
  await expect(page).toHaveURL(/\/problems$/);
}

test('游客投稿榜单支持排序分页，窄屏长昵称不溢出',async({page},testInfo)=>{
  const rows=Array.from({length:31},(_,i)=>({id:String(i+1),nickname:i===0?'一位昵称比较长的合成投稿人':'合成投稿人 '+(i+1),submitted:40-i,approved:i,rejected:31-i}));
  await page.route('**/api/v1/leaderboard?*',async route=>{
    const url=new URL(route.request().url());
    const sort=url.searchParams.get('sort') as 'submitted'|'approved'|'rejected';
    const pageNumber=Number(url.searchParams.get('page'));
    const sorted=[...rows].sort((a,b)=>b[sort]-a[sort]);
    await route.fulfill({json:{items:sorted.slice((pageNumber-1)*30,pageNumber*30),total:31,page:pageNumber,pageSize:30}});
  });
  await page.goto('/leaderboard');
  await expect(page.getByRole('heading',{name:'投稿榜单'})).toBeVisible();
  await expect(page.getByRole('link',{name:'登录 / 注册'})).toBeVisible();
  await expect(page.locator('tbody tr').first()).toContainText('一位昵称比较长');
  await page.getByRole('combobox',{name:'排序方式'}).selectOption('approved');
  await expect(page.locator('tbody tr').first()).toContainText('合成投稿人 31');
  await page.getByRole('button',{name:'下一页'}).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('combobox',{name:'排序方式'}).selectOption('rejected');
  await expect(page.locator('tbody tr')).toHaveCount(30);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:testInfo.outputPath('leaderboard.png'),fullPage:true});
});

test('题目与用户管理可查看投稿联系方式，换成普通账号后不可读取',async({page},testInfo)=>{
  await loginAs(page,/投稿人/);
  const origin='http://localhost:5173';
  const before=await page.request.get('/api/v1/me').then(r=>r.json());
  const response=await page.request.patch('/api/v1/me',{headers:{origin},data:{qq:'123456789'}});
  expect(response.ok()).toBe(true);
  const created=await page.request.post('/api/v1/problems',{headers:{origin},data:{title:'合成联系方式验证',type:'traditional',tagIds:['catalog.tag.02.09'],content:{basicStatement:'合成内容',basicSolution:'合成解答'},externalReviewEnabled:false}});
  expect(created.ok()).toBe(true);
  const problem=await created.json();
  await loginAs(page,/系统管理员/);
  await page.goto(`/problems/${problem.id}`);
  await page.getByRole('button',{name:'查看联系方式',exact:true}).click();
  await expect(page.getByRole('region',{name:'投稿人联系方式'})).toContainText('123456789');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  await page.goto('/admin/users');
  await page.locator('.permission-user-select').filter({hasText:before.nickname}).click();
  await page.getByRole('button',{name:'查看联系方式',exact:true}).click();
  await expect(page.getByRole('region',{name:'投稿人联系方式'})).toContainText('123456789');
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:testInfo.outputPath('admin-contact.png'),fullPage:true});
  await loginAs(page,/投稿人/);
  await page.goto(`/problems/${problem.id}`);
  await expect(page.getByRole('button',{name:'查看联系方式',exact:true})).toHaveCount(0);
  expect((await page.request.get(`/api/v1/admin/users/${before.id}/contact`)).status()).toBe(404);
  await page.request.patch('/api/v1/me',{headers:{origin},data:{qq:before.qq}});
});

test('中文候选输入期间不改变搜索，确认后保留焦点并提交完整词语',async({page})=>{
  await loginAs(page,/投稿人/);
  const input=page.getByPlaceholder('搜索题号或名称');
  const searches:string[]=[];
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/v1/problems'&&url.searchParams.has('search')) searches.push(url.searchParams.get('search')!);});
  await input.focus();
  await input.dispatchEvent('compositionstart',{data:''});
  await input.fill('zhong');
  await page.waitForTimeout(450);
  expect(searches).toEqual([]);
  await input.fill('中文');
  await input.dispatchEvent('compositionend',{data:'中文'});
  await expect.poll(()=>searches).toContain('中文');
  expect(searches).not.toContain('zhong');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('中文');
});
