import {expect,test} from '@playwright/test';
test('代码高亮保留原文，编辑区随内容及预览伸缩，题号双向排序',async({page},info)=>{
 await page.goto('/demo-login');await page.getByRole('button',{name:/投稿人/}).click();await expect(page).toHaveURL(/\/problems$/);
 await page.goto('/problems/new');const editor=page.getByRole('region',{name:'基础题面',exact:true}),input=editor.getByRole('textbox',{name:'基础题面',exact:true});
 const long='```cpp\n#include <iostream>\nint main() { return 42; }\n```\n\n'+Array.from({length:60},(_,i)=>`第 ${i+1} 行说明，保留原始文本。`).join('\n');
 await input.fill(long);await expect(input).toHaveValue(long);
 await expect.poll(()=>input.evaluate(el=>el.clientHeight)).toBeGreaterThan(900);
 expect(await input.evaluate(el=>el.scrollHeight-el.clientHeight)).toBeLessThanOrEqual(2);
 if(info.project.name.startsWith('mobile'))await editor.getByRole('button',{name:'预览',exact:true}).click();
 await expect(editor.locator('.hljs-keyword').first()).toBeVisible();await expect(editor.locator('pre code')).toHaveText('#include <iostream>\nint main() { return 42; }\n');
 if(info.project.name.startsWith('mobile'))await editor.getByRole('button',{name:'编辑',exact:true}).click();
 await input.fill('# 标题\n\n'+Array.from({length:10},(_,i)=>`## 小节 ${i}\n\n说明`).join('\n\n'));
 if(!info.project.name.startsWith('mobile')){await expect.poll(()=>editor.evaluate(el=>Math.abs(el.querySelector('textarea')!.getBoundingClientRect().height-el.querySelector('.editor-preview-pane')!.getBoundingClientRect().height))).toBeLessThanOrEqual(2);}
 await input.fill('短文本');await expect.poll(()=>input.evaluate(el=>el.clientHeight)).toBeLessThan(400);
 await input.fill('```python\n# 保留缩进\nfor i in range(3):\n    print(i)\n```\n\n\\(x_i^2\\)');
 if(info.project.name.startsWith('mobile'))await editor.getByRole('button',{name:'预览',exact:true}).click();await expect(editor.locator('.hljs-keyword').first()).toBeVisible();await expect(editor.locator('.katex-error')).toHaveCount(0);
 await editor.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('markdown-editor.png')});
 for(const sort of ['id_asc','id_desc']){
  await page.goto('/problems?sort='+sort);await expect(page.getByRole('combobox',{name:'排序',exact:true})).toHaveValue(sort);
  const response=await page.request.get('/api/v1/problems?sort='+sort+'&pageSize=50');expect(response.ok()).toBe(true);const data=await response.json();const ids=data.items.map((p:{id:string})=>BigInt(p.id));expect(ids.length).toBeGreaterThan(1);
  for(let i=1;i<ids.length;i++)expect(sort==='id_asc'?ids[i]>ids[i-1]:ids[i]<ids[i-1]).toBe(true);
 }
});
