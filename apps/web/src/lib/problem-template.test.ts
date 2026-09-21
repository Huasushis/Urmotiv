import {expect,it} from 'vitest';
import {parseProblemTemplate,problemTemplate} from './problem-template';
const valid='# 合成题目\n\n## 基础题面\n\n计算 $a+b$。\n\n## 基础题解\n\n直接相加。\n';
it('模板保留正式分区、代码块与样例顺序，代码中的二级标题不误识别',()=>{
 const result=parseProblemTemplate(valid+'\n## 正式题解\n\n### 思路\n\n```cpp\n## 基础题解\n```\n\n## 样例 2 输入\n\n```text\n2 3\n```\n\n## 样例 2 输出\n\n```text\n5\n```\n');
 expect(result.title).toBe('合成题目');expect(result.content.solution).toContain('## 基础题解');expect(result.samples).toEqual([{id:expect.stringMatching(/^[a-f0-9-]{36}$/),input:'2 3',output:'5',explanation:''}]);
});
it('未填写空白模板、未知/重复分区、多题和不完整样例均不会静默丢内容',()=>{
 for(const text of [problemTemplate,valid+'\n## 自定义分区\n内容',valid+'\n## 基础题面\n重复',valid+'\n# 第二题',valid+'\n## 样例 1 输入\n1 2'])expect(()=>parseProblemTemplate(text)).toThrow();
 expect(parseProblemTemplate('\uFEFF'+valid.replaceAll('\n','\r\n')).content.basicSolution).toBe('直接相加。');
});
