import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'../..'),dir=mkdtempSync(join(tmpdir(),'urmotiv-control-'));
try{
 const bin=join(dir,'bin'),log=join(dir,'commands.log');mkdirSync(bin);
 copyFileSync(join(root,'deploy/urmotivctl'),join(dir,'urmotivctl'));
 copyFileSync(join(root,'deploy/fermata-maintenance.mjs'),join(dir,'fermata-maintenance.mjs'));
 writeFileSync(join(dir,'compose.yaml'),'services: {}\n');writeFileSync(join(dir,'urmotiv.env'),'NOT_SHELL=$(touch NEVER_EXECUTE)\n',{mode:0o600});
 writeFileSync(join(bin,'docker'),`#!/usr/bin/env node
const fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(process.env.CONTROL_TEST_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='info')process.exit(process.env.DOCKER_DOWN==='1'?1:0);
if(a[0]==='inspect'){
 const template=a[2];console.log(template.includes('working_dir')?(process.env.WRONG_OWNER==='1'?'/other':process.env.URMOTIV_DEPLOY_DIR):template.includes('compose.project')?'urmotiv-production':template.includes('State.Pid')?'0':'running healthy');process.exit(0);
}
if(a.includes('config')){console.log('postgres\\nredis\\nminio\\napi\\nworker\\nweb\\nfermata\\nanklang');process.exit(0);}
if(a.includes('ps')&&a.includes('-q')){console.log('fixture-container');process.exit(0);}
if(a.includes('exec')){fs.readFileSync(0);if(a.at(-1)==='idle'&&process.env.DRAIN_BUSY==='1')process.exit(2);console.log('{}');process.exit(0);}
if(a.includes('up')&&process.env.UP_FAIL==='1')process.exit(1);
`,{mode:0o700});
 for(const cmd of ['curl','sleep'])writeFileSync(join(bin,cmd),'#!/bin/sh\nexit 0\n',{mode:0o700});
 const run=(action,extra={})=>{writeFileSync(log,'');const result=spawnSync('bash',[join(dir,'urmotivctl'),action],{env:{...process.env,PATH:bin+':'+process.env.PATH,CONTROL_TEST_LOG:log,URMOTIV_DEPLOY_DIR:dir,...extra},encoding:'utf8'});return {result,commands:readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x))};};
 let x=run('restart');assert.equal(x.result.status,0,x.result.stderr);
 const actions=x.commands.filter(a=>a.includes('stop')||a.includes('up')||a.includes('exec'));
 assert(actions.findIndex(a=>a.at(-1)==='drain')<actions.findIndex(a=>a.includes('stop')));
 assert(actions.findIndex(a=>a.at(-1)==='idle')<actions.findIndex(a=>a.includes('stop')));
 assert(actions.findIndex(a=>a.includes('up'))>actions.findLastIndex(a=>a.includes('stop')));
 assert(actions.find(a=>a.includes('up')).includes('--no-build'));
 assert(!x.commands.some(a=>a.some(v=>['down','rm','prune','build'].includes(v))));
 for(const [action,env]of [['stop',{DRAIN_BUSY:'1',URMOTIV_DRAIN_TIMEOUT:'1'}],['restart',{WRONG_OWNER:'1'}],['start',{DOCKER_DOWN:'1'}]]){
  x=run(action,env);assert.notEqual(x.result.status,0);assert(!x.commands.some(a=>a.includes('stop')||a.includes('up')));
 }
 x=run('start',{UP_FAIL:'1'});assert.notEqual(x.result.status,0);assert(!x.commands.some(a=>a.at(-1)==='resume'));
 console.log('生产启停脚本：顺序、任务排空、归属拒绝、Docker不可用、启动失败和无删除路径检查通过。');
}finally{rmSync(dir,{recursive:true,force:true});}
