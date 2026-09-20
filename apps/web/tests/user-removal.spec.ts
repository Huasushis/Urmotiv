import{expect,test,request}from'@playwright/test';
import{randomUUID}from'node:crypto';

test('删除账号前确认，取消不更改账号，确认后保留其题目并转移归属',async({page},testInfo)=>{
  const unique=randomUUID().replaceAll('-','').slice(0,12);
  const username='removal-'+unique;const password='Synthetic-removal-password';
  await page.goto('/demo-login');await page.getByRole('button',{name:/系统管理员/}).click();await expect(page).toHaveURL(/\/problems$/);
  const actor=await page.request.get('/api/v1/session').then(r=>r.json());
  const created=await page.request.post('/api/v1/admin/accounts/batch',{headers:{origin:'http://localhost:5173'},data:{text:[username,'合成待删除账号',unique+'@example.test',password].join('\t')}});
  expect(created.ok()).toBe(true);
  const found=await page.request.get('/api/v1/admin/users?search='+username).then(r=>r.json());const target=found.items[0];expect(target).toBeTruthy();
  // 独立请求上下文以新账号登录并投稿，管理员浏览器会话不变。
  const own=await request.newContext({baseURL:'http://127.0.0.1:5173',extraHTTPHeaders:{origin:'http://localhost:5173'}});
  const login=await own.post('/api/v1/auth/username-login',{data:{username,password}});
  expect(login.ok()).toBe(true);
  const posted=await own.post('/api/v1/problems',{data:{title:'合成保留的投稿',type:'traditional',tagIds:['catalog.tag.02.09'],content:{basicStatement:'合成内容',basicSolution:'合成解答'},externalReviewEnabled:false}});
  expect(posted.ok()).toBe(true);const problem=await posted.json();
  await page.goto('/admin/users');
  await page.getByPlaceholder('昵称、用户名或账号 ID').fill(username);
  await page.locator('.permission-user-select').filter({hasText:'合成待删除账号'}).click();
  const remove=page.getByRole('button',{name:'删除账号',exact:true});await expect(remove).toBeVisible();
  page.once('dialog',dialog=>dialog.dismiss());await remove.click();await expect(remove).toBeVisible();
  expect((await page.request.get('/api/v1/admin/users?search='+username).then(r=>r.json())).total).toBe(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:testInfo.outputPath('delete-user-confirmation.png'),fullPage:true});
  page.once('dialog',dialog=>dialog.accept());await remove.click();
  await expect.poll(()=>page.request.get('/api/v1/admin/users?search='+username).then(r=>r.json()).then(body=>body.total)).toBe(0);
  const after=await page.request.get('/api/v1/problems/'+problem.id).then(r=>r.json());expect(after.owner.id).toBe(actor.user.id);expect(after.content.basicStatement).toBe('合成内容');
  expect((await own.get('/api/v1/me')).status()).toBe(401);await own.dispose();
});
