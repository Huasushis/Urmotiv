import {expect,test} from '@playwright/test';
test('投稿人可从我的投稿撤回待审、通过、不通过，历史记录保留',async({page,context},info)=>{
 await page.goto('/demo-login');await page.getByRole('button',{name:/投稿人/}).click();await expect(page).toHaveURL(/\/problems$/);
 const tags=await page.request.get('/api/v1/tags').then(r=>r.json());const tagId=tags.items.find((t:{active:boolean})=>t.active!==false).id;
 const leader=await context.browser()!.newContext({baseURL:'http://127.0.0.1:5173'});
 const login=await leader.request.post('/api/v1/auth/demo-login',{headers:{origin:'http://localhost:5173'},data:{userId:'leader'}});expect(login.ok()).toBe(true);
 try{for(const state of ['pending_review','approved','rejected']){
  const title=`合成撤回-${info.project.name}-${state}-${Date.now()}`;
  const draft=await page.request.post('/api/v1/problems',{headers:{origin:'http://localhost:5173'},data:{title,type:'traditional',tagIds:[tagId],externalReviewEnabled:false,content:{basicStatement:'给定一个整数，输出它本身。',basicSolution:'直接输出即可。',background:'',statement:'',inputFormat:'',outputFormat:'',constraints:'',solution:'',hints:''}}}).then(r=>r.json());
  const pending=await page.request.post(`/api/v1/problems/${draft.id}/submit`,{headers:{origin:'http://localhost:5173'},data:{expectedRevision:draft.revision}}).then(r=>r.json());expect(pending.status).toBe('pending_review');
  if(state!=='pending_review'){const decision=await leader.request.post(`/api/v1/problems/${draft.id}/review-decision`,{headers:{origin:'http://localhost:5173'},data:{expectedRevision:pending.revision,expectedRound:pending.reviewRound,decision:state==='approved'?'approve':'reject',reason:'合成验收决定'}});expect(decision.ok()).toBe(true);}
  await page.goto('/submissions?search='+encodeURIComponent(title));
  const row=page.getByRole('row').filter({has:page.getByText(title,{exact:true})});await expect(row.getByRole('button',{name:'撤回为草稿'})).toBeVisible();
  page.once('dialog',dialog=>dialog.accept());await row.getByRole('button',{name:'撤回为草稿'}).click();await expect(row).toContainText('草稿');await expect(row.getByRole('button',{name:'撤回为草稿'})).toHaveCount(0);
  const saved=await page.request.get(`/api/v1/problems/${draft.id}`).then(r=>r.json());expect(saved.status).toBe('draft');expect(saved.reviewRound).toBe(pending.reviewRound);
  const history=await page.request.get(`/api/v1/problems/${draft.id}/reviews`).then(r=>r.json());expect(history.status).toBe(state==='pending_review'?'withdrawn':state);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
 }
 await page.screenshot({path:info.outputPath('withdrawn-submission.png')});
 }finally{await leader.close();}
});
