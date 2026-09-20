import {expect,test} from '@playwright/test';
import type {Contest} from '@urmotiv/contracts';

test('比赛归档可发现、需要确认，失败不伪装成功，归档后仍可查看导出',async({page},testInfo)=>{
  let item:Contest={id:'88',title:'秋日算法练习赛',description:'由一份想法开始，编排成一场比赛。',state:'draft',startsAt:null,endsAt:null,
    creator:{id:'1',nickname:'命题小组',accountType:'human'},members:[],createdAt:'2026-09-20T00:00:00.000Z',updatedAt:'2026-09-20T00:00:00.000Z',
    capabilities:{canEdit:true,canDelete:true,canExport:true,canReadRisk:false},
    problems:['起始音','回声与路径','终止式'].map((title,i)=>({problemId:String(i+1),title,revision:3,revisionId:`00000000-0000-4000-8000-00000000000${i+1}`,position:i,score:100,estimatedDifficulty:null,leakRiskCount:0,leakRiskEntries:[]}))};
  let calls=0;let conflict=true;
  await page.route('**/api/v1/contests',route=>route.fulfill({json:{items:[{...item,problemCount:3,participantCount:0,leakRiskCount:0}]}}));
  await page.route('**/api/v1/contests/88',route=>{
    if(route.request().method()==='PATCH'){
      calls++;
      expect(route.request().postDataJSON()).toEqual({state:'archived',expectedUpdatedAt:item.updatedAt});
      if(conflict)return route.fulfill({status:409,json:{error:{code:'CONFLICT',message:'方案已经更新，请重新打开后操作。'}}});
      item={...item,state:'archived',updatedAt:'2026-09-20T01:00:00.000Z',capabilities:{...item.capabilities,canEdit:false}};
    }
    return route.fulfill({json:item});
  });
  await page.goto('/demo-login');await page.getByRole('button',{name:/组长/}).click();await expect(page).toHaveURL(/\/problems$/);
  await page.goto('/contests');
  const archive=page.getByRole('button',{name:'归档比赛',exact:true});await expect(archive).toBeVisible();
  page.once('dialog',dialog=>dialog.dismiss());await archive.click();expect(calls).toBe(0);
  page.once('dialog',dialog=>dialog.accept());await archive.click();await expect(page.getByRole('alert')).toContainText('方案已经更新');
  await expect(page.getByRole('navigation',{name:'比赛方案分类'}).getByRole('button',{name:/进行中/})).toHaveAttribute('aria-pressed','true');
  conflict=false;page.once('dialog',dialog=>dialog.accept());await archive.click();
  await expect(page).toHaveURL(/view=archived/);
  await expect(page.locator('.contest-archive-notice')).toContainText('只读保留');
  await expect(archive).toHaveCount(0);
  await expect(page.getByRole('button',{name:'导出比赛题目包',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('heading',{name:item.title,exact:true})).toBeVisible();
  await expect(page.locator('.contest-detail-table tbody tr')).toHaveCount(3);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({path:testInfo.outputPath('contest-archive.png'),fullPage:true});
  await page.getByRole('navigation',{name:'比赛方案分类'}).getByRole('button',{name:/进行中/}).click();
  await expect(page.getByRole('heading',{name:item.title,exact:true})).toHaveCount(0);
  await page.getByRole('navigation',{name:'比赛方案分类'}).getByRole('button',{name:/已归档/}).click();
  await expect(page.getByRole('heading',{name:item.title,exact:true})).toBeVisible();
});
