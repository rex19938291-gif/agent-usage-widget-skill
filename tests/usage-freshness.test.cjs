const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const installer = fs.readFileSync(path.join(__dirname, '../agent-usage-widget-skill/scripts/install-agent-usage-widget.sh'), 'utf8');
const source = installer.split("<<'NODE'\n")[1].split('\nNODE\n')[0];
function fixture(t, age = 0, expired = false) {
  const tmpRoot = path.join(__dirname, '../.test-tmp');
  fs.mkdirSync(tmpRoot, {recursive: true});
  const home = fs.mkdtempSync(path.join(tmpRoot, 'usage-regression-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const install = path.join(home, '.agent-usage-widget');
  fs.mkdirSync(path.join(install, '.cache'), {recursive: true});
  const script = path.join(install, 'summary.js');
  const mock = (injection = '') => fs.writeFileSync(script, source.replace('main().catch(', `
readClaudeLongLivedLogin = () => "";
readClaudeDesktopSession = () => ({});
fetch = async () => { throw new Error("offline test forbids unexpected network"); };
${injection}
main().catch(`));
  mock();
  const fetchedAt = new Date(Date.now() - age).toISOString();
  const resetsAt = Date.now()/1000 + (expired ? -60 : 3600);
  const claude = {available: true, attemptId: "fixture-success", fetchedAt, fiveHour: {usedPercent: 100, resetsAt}, weekAll: {usedPercent: 37, resetsAt: Date.now()/1000+86400}, weekScoped: {usedPercent: 1, resetsAt: Date.now()/1000+86400, label: 'Fable'}};
  const codex = {available: true, fetchedAt, fiveHour: {usedPercent: 80, resetsAt}, week: {usedPercent: 11, resetsAt: Date.now()/1000+86400}};
  const save = () => {
    for (const [vendor, data] of Object.entries({claude,codex})) fs.writeFileSync(path.join(install, '.cache', vendor+'-usage-percentages.json'), JSON.stringify(data));
    fs.writeFileSync(path.join(install,'.cache/claude-oauth-poll.json'),JSON.stringify({attemptId:claude.attemptId,state:'succeeded',startedAt:Date.now()-601000}));
  };
  const run = (...args) => execFileSync(process.execPath, [script, '--quota-only', ...args], {env:{HOME:home,PATH:'/usr/bin:/bin'}, encoding:'utf8', timeout:5000});
  save(); return {claude, codex, save, run, script, home, install, mock};
}
test('fresh exhausted Claude session is 0% remaining, not 100%', t => {
  const f = fixture(t); const data = JSON.parse(f.run());
  assert.equal(data.claude.official.fiveHour.usedPercent, 100);
  assert.match(f.run('--text'), /5 小時 0%/);
});
test('an expired reset never implies unused quota in the next window', t => {
  const data = JSON.parse(fixture(t, 0, true).run());
  assert.equal(data.claude.official.fiveHour.usedPercent, null);
  assert.equal(data.codex.rateLimits.primary.used_percent, null);
  assert.equal(data.codex.official.fiveHour.usedPercent, null);
});
test('old cache stays unknown despite a new report generation time', t => {
  const f = fixture(t, 13*3600*1000); const data = JSON.parse(f.run());
  assert.ok(Date.now()-Date.parse(data.generatedAt)<5000);
  assert.equal(data.claude.official.available, false);
  assert.equal(data.claude.official.weekAll.usedPercent, null);
  assert.equal(data.claude.official.weekScoped.label, 'Fable');
  assert.equal(data.codex.rateLimits.secondary.used_percent, null);
  assert.equal(data.codex.official.week.usedPercent, null);
  assert.match(f.run('--text'), /Claude 讀取失敗：stale_usage/);
});
test('a fresh weekly-only plan retains its absent 5-hour window', t => {
  const f=fixture(t); f.codex.fiveHour=null; f.save();
  assert.match(f.run('--text'), /5 小時 此方案無此限制/);
});
test('missing and future observation times cannot pass freshness checks', t => {
  const f=fixture(t);
  for (const stamp of [null, 'invalid', new Date(Date.now()+120000).toISOString()]) {
    f.claude.fetchedAt=stamp; f.codex.fetchedAt=stamp; f.save();
    const data=JSON.parse(f.run());
    assert.equal(data.claude.official.fiveHour.usedPercent,null);
    assert.equal(data.codex.rateLimits.secondary.used_percent,null);
  }
});

test('rejected live refresh invalidates even a recent full-availability cache', t => {
  const f=fixture(t, 60000);
  f.claude.fiveHour.usedPercent=0; f.save();
  f.mock(`readClaudeDesktopSession = () => ({orgId: "test", cookieHeader: "test=dummy"});
fetch = async () => ({ok: false, status: 403});`);
  const data=JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.available, false);
  assert.equal(data.claude.official.error, 'http_403');
  assert.equal(data.claude.official.fiveHour.usedPercent, null);
  assert.equal(data.claude.official.weekScoped.label, 'Fable');
  assert.match(f.run('--refresh-claude', '--text'), /Claude 讀取失敗：http_403/);
});

function oauthMock(f, status = 200, headerValues = {}) {
  f.mock(`
readClaudeLongLivedLogin = () => "dummy-offline-login";
fetch = async (url, options) => {
  const assert = require("node:assert/strict");
  const counter = path.join(HOME, "request-count");
  fs.writeFileSync(counter, String(Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0) + 1));
  assert.equal(options.headers.authorization, "Bearer dummy-offline-login");
  assert.equal(options.redirect, "error");
  if (url.endsWith("/api/oauth/usage")) return {status: 429};
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(JSON.parse(options.body).max_tokens, 1);
  assert.equal(JSON.parse(options.body).model, "claude-haiku-4-5");
  return {status: ${status}, headers: new Headers(${JSON.stringify(headerValues)})};
};`);
}
function headersAt(reset = Date.now()/1000 + 3600) {
  return {'anthropic-ratelimit-unified-5h-utilization':'0.39',
    'anthropic-ratelimit-unified-5h-reset':String(reset),
    'anthropic-ratelimit-unified-7d-utilization':'0.76',
    'anthropic-ratelimit-unified-7d-reset':String(Date.now()/1000+86400)};
}
for (const status of [200, 429]) test(`Claude messages ${status} headers supply rounded percentages and retain unknown scoped label`, t => {
  const f = fixture(t); oauthMock(f, status, headersAt());
  const data = JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.available, true);
  assert.equal(data.claude.official.fiveHour.usedPercent, 39);
  assert.equal(data.claude.official.weekAll.usedPercent, 76);
  assert.equal(data.claude.official.weekScoped.usedPercent, null);
  assert.equal(data.claude.official.weekScoped.label, 'Fable');
  assert.equal(Number(fs.readFileSync(path.join(f.home, 'request-count'))), 2);
  const state = fs.readFileSync(path.join(f.install,'.cache/claude-oauth-poll.json'),'utf8');
  const cache = fs.readFileSync(path.join(f.install,'.cache/claude-usage-percentages.json'),'utf8');
  assert.doesNotMatch(state+cache, /dummy-offline-login/);
});
test('Claude refresh reuses nine-minute OAuth cache without another request', t => {
  const f=fixture(t, 9*60000);
  f.claude.source='oauth_headers'; f.save();
  const stamp=Date.parse(f.claude.fetchedAt);
  fs.writeFileSync(path.join(f.install,'.cache/claude-oauth-poll.json'), JSON.stringify({attemptId:f.claude.attemptId,state:'succeeded',startedAt:stamp}));
  f.mock('readClaudeLongLivedLogin = () => { throw new Error("must not read login during throttle"); };');
  const data=JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.available,true);
  assert.equal(data.claude.official.fiveHour.usedPercent,100);
  assert.match(f.run('--text'), /5 小時 0%/);
});
test('Claude nine-minute cached window crossing reset is unknown', t => {
  const f=fixture(t,9*60000,true); f.claude.source='oauth_headers'; f.save();
  const data=JSON.parse(f.run());
  assert.equal(data.claude.official.available,true);
  assert.equal(data.claude.official.fiveHour.usedPercent,null);
  assert.equal(data.claude.official.weekAll.usedPercent,37);
});
test('Claude OAuth cache older than ten minutes is unknown', t => {
  const f=fixture(t,601000); f.claude.source='oauth_headers'; f.save();
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,null);
});
test('failed OAuth refresh is throttled and cannot revive a recent cached 100%', t => {
  const f=fixture(t,60000); f.claude.source='oauth_headers'; f.claude.fiveHour.usedPercent=0; f.save();
  oauthMock(f,429,{});
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,null);
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,null);
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,null);
  assert.equal(Number(fs.readFileSync(path.join(f.home,'request-count'))),2);
});
test('the tenth minute permits a new OAuth polling cycle', t => {
  const f=fixture(t); const stamp=Date.now()-601000;
  fs.writeFileSync(path.join(f.install,'.cache/claude-oauth-poll.json'), JSON.stringify({attemptId:'pending-attempt',state:'in_progress',startedAt:stamp}));
  oauthMock(f,200,headersAt());
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,39);
  assert.equal(Number(fs.readFileSync(path.join(f.home,'request-count'))),2);
});
test('OAuth usage success skips messages and uses scoped model data', t => {
  const f=fixture(t);
  f.mock(`readClaudeLongLivedLogin = () => "dummy";
fetch = async url => {
 if (!url.endsWith('/api/oauth/usage')) throw new Error('messages must not run');
 return {status:200, json:async()=>({five_hour:{utilization:42,resets_at:nowMs/1000+3600},seven_day:{utilization:76,resets_at:nowMs/1000+86400},seven_day_fable:{utilization:44,resets_at:nowMs/1000+86400}})};
};`);
  const data=JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.source,'oauth_usage');
  assert.equal(data.claude.official.weekScoped.label,'Fable');
  assert.equal(data.claude.official.weekScoped.usedPercent,44);
});
function record(f, {age=3600000, expired=false, name='rollout-test.jsonl', dayOffset=0, percent=10, mtime=Date.now()} = {}) {
  const day=new Date(); day.setDate(day.getDate()-dayOffset);
  const dir=path.join(f.home,'.codex/sessions',String(day.getFullYear()),String(day.getMonth()+1).padStart(2,'0'),String(day.getDate()).padStart(2,'0'));
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,name);
  const row={timestamp:new Date(Date.now()-age).toISOString(),payload:{type:'token_count',rate_limits:{primary:{used_percent:percent,window_minutes:10080,resets_at:Date.now()/1000+(expired?-60:86400)},secondary:null}}};
  fs.writeFileSync(file, JSON.stringify(row)+'\n'+JSON.stringify({type:'other',content:'中文字'.repeat(30000)})+'\n{broken tail');
  fs.utimesSync(file,mtime/1000,mtime/1000);
  return file;
}
test('Codex tail parser classifies weekly-only records and labels the observation time', t=>{
  const f=fixture(t,600000); record(f);
  const data=JSON.parse(f.run());
  assert.equal(data.codex.official.source,'session_record');
  assert.equal(data.codex.official.fiveHour,null);
  assert.equal(data.codex.rateLimits.secondary.used_percent,10);
  assert.equal(data.codex.filesScanned,1);
  assert.match(f.run('--text'),/最後紀錄/);
  assert.match(f.run('--text'),/此方案無此限制/);
});
test('Codex recorded reset expiry never guesses zero usage', t=>{
  const f=fixture(t,600000); record(f,{expired:true});
  const data=JSON.parse(f.run());
  assert.equal(data.codex.official.week.usedPercent,null);
  assert.equal(data.codex.rateLimits?.secondary?.used_percent ?? null,null);
});
test('Codex chooses newer observation across official cache and session record', t=>{
  const f=fixture(t,60000); record(f,{age:30000,percent:12});
  let data=JSON.parse(f.run());
  assert.equal(data.codex.official.source,'session_record');
  assert.equal(data.codex.rateLimits.secondary.used_percent,12);
  f.codex.fetchedAt=new Date(Date.now()-10000).toISOString();f.save();
  data=JSON.parse(f.run());
  assert.equal(data.codex.rateLimits.secondary.used_percent,11);
});
test('Codex official rejection falls back to records without keeping the rejection error', t=>{
  const f=fixture(t);record(f);
  f.mock('fetchCodexOfficialUsage = async () => ({available:false,error:"http_403"});');
  const data=JSON.parse(f.run('--refresh-codex'));
  assert.equal(data.codex.official.available,true);
  assert.equal(data.codex.official.error,undefined);
  assert.equal(data.codex.rateLimits.secondary.used_percent,10);
});
test('Codex inspects at most five latest files and excludes stale modification times', t=>{
  const f=fixture(t,600000);
  record(f,{dayOffset:2,name:'rollout-old.jsonl',percent:99,mtime:Date.now()-3*86400000});
  for(let i=0;i<7;i++) record(f,{name:`rollout-${i}.jsonl`,percent:i,age:60000+i*1000,mtime:Date.now()-i*1000});
  const data=JSON.parse(f.run());
  assert.equal(data.codex.filesScanned,5);
  assert.equal(data.codex.rateLimits.secondary.used_percent,0);
});

test('invalid Claude headers cannot fabricate zero percent or accept a crossed reset', t=>{
  const f=fixture(t);const values=headersAt();
  values['anthropic-ratelimit-unified-5h-reset']=String(Date.now()/1000-1);
  values['anthropic-ratelimit-unified-7d-utilization']='not-a-number';
  oauthMock(f,429,values);
  const data=JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.available,false);
  assert.equal(data.claude.official.fiveHour.usedPercent,null);
  assert.equal(data.claude.official.weekAll.usedPercent,null);
});
test('a later cookie failure also invalidates cache-only reports', t=>{
  const f=fixture(t,60000);f.claude.fiveHour.usedPercent=0;f.save();
  f.mock(`readClaudeDesktopSession = () => ({orgId:"dummy",cookieHeader:"dummy"});
fetch = async () => ({ok:false,status:403});`);
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,null);
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,null);
});
test('Codex classifies a five-hour window in the secondary slot', t=>{
  const f=fixture(t,600000);const file=record(f);
  const row={timestamp:new Date().toISOString(),payload:{type:'token_count',rate_limits:{
    primary:{used_percent:10,window_minutes:10080,resets_at:Date.now()/1000+86400},
    secondary:{used_percent:45,window_minutes:300,resets_at:Date.now()/1000+3600}}}};
  fs.writeFileSync(file,JSON.stringify(row)+'\n');
  const data=JSON.parse(f.run());
  assert.equal(data.codex.rateLimits.primary.used_percent,45);
  assert.equal(data.codex.rateLimits.secondary.used_percent,10);
});
test('Codex uses the final event in a file rather than an earlier higher percentage', t=>{
  const f=fixture(t,600000);const file=record(f);
  const earlier=fs.readFileSync(file,'utf8').split('\n')[0];const latest=JSON.parse(earlier);
  latest.timestamp=new Date().toISOString();latest.payload.rate_limits.primary.used_percent=4;
  fs.writeFileSync(file,earlier+'\n'+JSON.stringify(latest)+'\n');
  assert.equal(JSON.parse(f.run()).codex.rateLimits.secondary.used_percent,4);
});

// Review regressions: fake HOME, fake login reader/fetch and injected filesystem failures.
test('第1項 P1: failed claim durably invalidates old full-availability cache', t=>{
  const f=fixture(t,60000); f.claude.fiveHour.usedPercent=0; f.save();
  f.mock(`
const realWrite = fs.writeFileSync;
fs.writeFileSync = function(file, ...args) {
  if (String(file).includes('claude-oauth-poll')) throw new Error('simulated ENOSPC');
  return realWrite.call(this, file, ...args);
};
readClaudeDesktopSession = () => ({orgId:'dummy',cookieHeader:'dummy'});
fetch = async () => ({ok:false,status:403});`);
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,null);
  f.mock(); // A new process, with writes restored, still cannot revive the invalid cache.
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour?.usedPercent ?? null,null);
});
test('第1項 P1: all writes and invalidation denied reject cache in memory and across processes', t=>{
  const f=fixture(t,60000);f.claude.fiveHour.usedPercent=0;f.save();
  const deny=`
for (const method of ['writeFileSync','truncateSync','unlinkSync']) {
  fs[method] = () => { throw new Error('simulated EACCES'); };
}`;
  f.mock(`${deny}
main = async () => {
 const assert = require('node:assert/strict');
 const failed = await fetchClaudeOfficialUsage({force:true});
 assert.equal(failed.available,false);
 const cached = await fetchClaudeOfficialUsage();
 assert.equal(cached.available,false);
 assert.equal(claudeCacheRejected,true);
 process.stdout.write('memory rejected');
};`);
  assert.equal(f.run(),'memory rejected');
  f.mock(deny);
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,null);
});
for (const invalid of [undefined, '', 'bad', 'Infinity', '0', String(Date.now()/1000-60)]) {
  test(`第2項 P1: zero utilization needs a future reset (${String(invalid)})`, t=>{
    const f=fixture(t); const values=headersAt();
    values['anthropic-ratelimit-unified-5h-utilization']='0';
    if (invalid===undefined) delete values['anthropic-ratelimit-unified-5h-reset'];
    else values['anthropic-ratelimit-unified-5h-reset']=invalid;
    oauthMock(f,429,values);
    const data=JSON.parse(f.run('--refresh-claude'));
    assert.equal(data.claude.official.fiveHour.usedPercent,null);
    assert.equal(data.claude.official.fiveHour.resetsAt,null);
    assert.equal(data.claude.official.weekAll.usedPercent,76);
  });
}
test('第2項 P1: weekly header needs its own valid future reset', t=>{
  const f=fixture(t);const values=headersAt();
  values['anthropic-ratelimit-unified-7d-utilization']='0';
  delete values['anthropic-ratelimit-unified-7d-reset'];
  oauthMock(f,200,values);
  const data=JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.fiveHour.usedPercent,39);
  assert.equal(data.claude.official.weekAll.usedPercent,null);
});
test('第3項 P2: in-flight throttle does not start a failing cookie fallback', t=>{
  const f=fixture(t,60000);f.claude.fiveHour.usedPercent=0;f.save();
  const stamp=Date.now();
  fs.writeFileSync(path.join(f.install,'.cache/claude-oauth-poll.json'),JSON.stringify({attemptId:'pending-attempt',state:'in_progress',startedAt:stamp}));
  f.mock(`
readClaudeDesktopSession = () => { throw new Error('cookie fallback must not start'); };
main = async () => {
 const assert = require('node:assert/strict');
 assert.equal((await fetchClaudeOfficialUsage({force:true})).error,'refresh_pending');
 assert.equal(readClaudePollState().state,'in_progress');
 const newer = {...readClaudeUsageCache({maxAgeMs:Infinity}),source:'oauth_headers',attemptId:'new-success',fetchedAt:new Date().toISOString(),fiveHour:{usedPercent:39,resetsAt:nowMs/1000+3600}};
 writeClaudeUsageCache(newer);
 writeClaudePollState({attemptId:'new-success',state:'succeeded',startedAt:${stamp}});
 assert.equal((await fetchClaudeOfficialUsage()).fiveHour.usedPercent,39);
 process.stdout.write('pending preserved success');
};`);
  assert.equal(f.run(),'pending preserved success');
});
test('第3項 P2: an older cookie failure cannot reject a newer concurrent success', t=>{
  const f=fixture(t,60000);
  f.mock(`
readClaudeDesktopSession = () => ({orgId:'dummy',cookieHeader:'dummy'});
fetch = async () => {
 const newer = {...readClaudeUsageCache({maxAgeMs:Infinity}),source:'oauth_headers',attemptId:'new-success',fetchedAt:new Date(nowMs-1000).toISOString(),fiveHour:{usedPercent:39,resetsAt:nowMs/1000+3600}};
 writeClaudeUsageCache(newer);
 const stamp=Date.now();writeClaudePollState({attemptId:'new-success',state:'succeeded',startedAt:stamp});
 return {ok:false,status:403};
};`);
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,39);
  f.mock();
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,39);
  const state=JSON.parse(fs.readFileSync(path.join(f.install,'.cache/claude-oauth-poll.json')));
  assert.equal(state.state,'succeeded');
  assert.equal(state.attemptId,'new-success');
});
test('第4項 P2: resumed three-day-old session is selected by recent modification', t=>{
  const f=fixture(t,600000);
  record(f,{dayOffset:3,age:30000,percent:10});
  f.mock('fetchCodexOfficialUsage = async () => ({available:false,error:"http_403"});');
  const data=JSON.parse(f.run('--refresh-codex'));
  assert.equal(data.codex.official.source,'session_record');
  assert.equal(data.codex.official.week.usedPercent,10);
  assert.equal(data.codex.filesScanned,1);
});
for (const failure of ['connection', 'json']) {
  test(`第5項 P2: first request ${failure} exception still tries messages under one throttle`, t=>{
    const f=fixture(t);
    f.mock(`
readClaudeLongLivedLogin = () => 'dummy';
fetch = async url => {
 const counter=path.join(HOME,'request-count');
 fs.writeFileSync(counter,String(Number(fs.existsSync(counter)?fs.readFileSync(counter,'utf8'):0)+1));
 if (url.endsWith('/api/oauth/usage')) {
   if (${JSON.stringify(failure)}==='connection') throw new Error('simulated connection failure');
   return {status:200,json:async()=>{throw new Error('simulated invalid content');}};
 }
 return {status:429,headers:new Headers(${JSON.stringify(headersAt())})};
};`);
    assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,39);
    assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.weekAll.usedPercent,76);
    assert.equal(Number(fs.readFileSync(path.join(f.home,'request-count'))),2);
  });
}

test('第2項 P1: persisted header observations with missing or invalid resets stay unknown', t=>{
  const f=fixture(t);
  f.claude.source='oauth_headers';
  f.claude.fiveHour={usedPercent:0};
  f.claude.weekAll={usedPercent:0,resetsAt:'invalid'};
  f.save();
  const data=JSON.parse(f.run());
  assert.equal(data.claude.official.fiveHour.usedPercent,null);
  assert.equal(data.claude.official.weekAll.usedPercent,null);
});

test('第二次第①項 P1: small files succeed but actual state replacement and cache invalidation fail', t=>{
  const f=fixture(t,60000);f.claude.fiveHour.usedPercent=0;f.save();
  const cachePath=path.join(f.install,'.cache/claude-usage-percentages.json');
  const original=fs.readFileSync(cachePath,'utf8');
  const partial=`
const originalRename=fs.renameSync, originalWrite=fs.writeFileSync;
fs.renameSync = function(from,to) {
 if (to===CLAUDE_POLL_STATE) throw new Error('simulated state replacement denied');
 return originalRename.call(this,from,to);
};
fs.writeFileSync = function(file,...args) {
 if(file===CLAUDE_POLL_STATE) throw new Error('simulated state overwrite denied');
 return originalWrite.call(this,file,...args);
};
fs.truncateSync = () => { throw new Error('simulated truncate denied'); };
fs.unlinkSync = () => { throw new Error('simulated unlink denied'); };
readClaudeLongLivedLogin = () => 'dummy';
fetch = async () => { originalWrite(path.join(HOME,'unexpected-network'),'called'); throw new Error('must not query'); };
// An unrelated probe can succeed: this must not authorize adopting old percentages.
fs.writeFileSync(path.join(HOME,'small-probe'),'0');`;
  f.mock(partial);
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,null);
  assert.equal(fs.existsSync(path.join(f.home,'unexpected-network')),false);
  assert.equal(fs.readFileSync(cachePath,'utf8'),original);
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,null); // new process, same partial failure
  assert.equal(fs.existsSync(path.join(f.home,'small-probe')),true);
});
test('第二次第①項 P1: percentage cache replacement failure leaves old ID unusable after restart', t=>{
  const f=fixture(t,60000);f.claude.fiveHour.usedPercent=0;f.save();
  f.mock(`
const originalRename=fs.renameSync;
fs.renameSync = function(from,to) {
 if(to===CLAUDE_USAGE_CACHE) throw new Error('simulated cache replacement denied');
 return originalRename.call(this,from,to);
};
readClaudeLongLivedLogin = () => 'dummy';
fetch = async () => ({status:200,json:async()=>({five_hour:{utilization:39,resets_at:nowMs/1000+3600}})});`);
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,null);
  const state=JSON.parse(fs.readFileSync(path.join(f.install,'.cache/claude-oauth-poll.json')));
  const cache=JSON.parse(fs.readFileSync(path.join(f.install,'.cache/claude-usage-percentages.json')));
  assert.equal(state.state,'failed');
  assert.notEqual(state.attemptId,cache.attemptId);
  assert.equal(cache.fiveHour.usedPercent,0); // Deliberately unchanged; the ID rule rejects it.
  f.mock();
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,null);
});
test('第二次第①項 P1: terminal state replacement failure cannot adopt even a newly written cache', t=>{
  const f=fixture(t,60000);
  f.mock(`
const originalRename=fs.renameSync;
fs.renameSync = function(from,to) {
 if(to===CLAUDE_POLL_STATE && JSON.parse(fs.readFileSync(from,'utf8')).state!=='in_progress') throw new Error('simulated terminal write denied');
 return originalRename.call(this,from,to);
};
readClaudeLongLivedLogin = () => 'dummy';
fetch = async () => ({status:200,json:async()=>({five_hour:{utilization:0,resets_at:nowMs/1000+3600}})});`);
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,null);
  const state=JSON.parse(fs.readFileSync(path.join(f.install,'.cache/claude-oauth-poll.json')));
  assert.equal(state.state,'in_progress');
  f.mock();
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,null);
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,null);
});
for(const rollback of [30000,4000]) test(`第二次新增 P1: clock rollback ${rollback/1000}s plus rejected refresh never treats unchanged cache as new success`, t=>{
  const f=fixture(t);f.claude.fiveHour.usedPercent=0;
  f.claude.fetchedAt=new Date(Date.now()+rollback).toISOString();f.save();
  f.mock(`
readClaudeDesktopSession = () => ({orgId:'dummy',cookieHeader:'dummy'});
fetch = async () => { fs.writeFileSync(path.join(HOME,'request-count'),'1'); return {ok:false,status:403}; };`);
  const result=JSON.parse(f.run('--refresh-claude'));
  assert.equal(result.claude.official.fiveHour.usedPercent,null);
  assert.equal(result.claude.official.available,false);
  assert.equal(fs.readFileSync(path.join(f.home,'request-count'),'utf8'),'1');
  f.mock();
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,null);
});
test('第二次第④項 P2: eight-day-old creation directory with fresh modification is included', t=>{
  const f=fixture(t,600000);record(f,{dayOffset:8,age:30000,percent:10});
  const data=JSON.parse(f.run());
  assert.equal(data.codex.filesScanned,1);
  assert.equal(data.codex.official.source,'session_record');
  assert.equal(data.codex.official.week.usedPercent,10);
});
test('第二次第④項 P2: more than 5000 files uses documented 30-day metadata fallback and five tails', t=>{
  const f=fixture(t,600000);
  const old=record(f,{dayOffset:40,name:'rollout-old.jsonl',percent:99});
  const oldDir=path.dirname(old);
  for(let i=0;i<5001;i++) fs.writeFileSync(path.join(oldDir,`rollout-empty-${i}.jsonl`),'');
  for(let i=0;i<6;i++) record(f,{dayOffset:8,name:`rollout-eight-${i}.jsonl`,percent:10+i,age:30000+i*1000,mtime:Date.now()-i*1000});
  const data=JSON.parse(f.run());
  assert.equal(data.codex.filesScanned,5);
  assert.equal(data.codex.official.week.usedPercent,10);
});
for (const invalid of ['missing','corrupt','legacy','mismatched','failed']) test(`第二次編號規則: ${invalid} state cannot authorize cached zero`,t=>{
  const f=fixture(t);f.claude.fiveHour.usedPercent=0;f.save();
  const statePath=path.join(f.install,'.cache/claude-oauth-poll.json');
  if(invalid==='missing') fs.unlinkSync(statePath);
  else if(invalid==='corrupt') fs.writeFileSync(statePath,'{');
  else fs.writeFileSync(statePath,JSON.stringify(invalid==='legacy'?{attemptedAt:Date.now(),succeededAt:Date.now()}:
    {attemptId:invalid==='mismatched'?'other-id':f.claude.attemptId,state:invalid==='failed'?'failed':'succeeded',startedAt:Date.now()}));
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,null);
});
test('第二次新鮮度: unchanged observation thirty seconds ahead is unknown without refresh',t=>{
  const f=fixture(t);f.claude.fetchedAt=new Date(Date.now()+30000).toISOString();f.claude.fiveHour.usedPercent=0;f.save();
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,null);
});

test('第二次節流保護: cookie refresh after three minutes does not repeat long-lived requests inside ten minutes', t=>{
  const f=fixture(t,181000);f.claude.source='desktop_cookie';f.save();
  const longStart=Date.now()-181000;
  fs.writeFileSync(path.join(f.install,'.cache/claude-oauth-poll.json'),JSON.stringify({attemptId:f.claude.attemptId,state:'succeeded',startedAt:longStart,longLivedStartedAt:longStart}));
  f.mock(`
readClaudeLongLivedLogin = () => { throw new Error('must skip long-lived query'); };
readClaudeDesktopSession = () => ({orgId:'dummy',cookieHeader:'dummy'});
fetch = async url => {
 const count=path.join(HOME,'request-count');fs.writeFileSync(count,String(Number(fs.existsSync(count)?fs.readFileSync(count,'utf8'):0)+1));
 if (!url.startsWith('https://claude.ai/')) throw new Error('unexpected long-lived query');
 return {ok:true,json:async()=>({five_hour:{utilization:39,resets_at:nowMs/1000+3600}})};
};`);
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,39);
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent,39);
  assert.equal(Number(fs.readFileSync(path.join(f.home,'request-count'))),1);
  const state=JSON.parse(fs.readFileSync(path.join(f.install,'.cache/claude-oauth-poll.json')));
  assert.equal(state.longLivedStartedAt,longStart);
});

for (const [manual, elapsed, expected] of [[true,59000,2],[true,60000,4],[true,61000,4],[false,61000,2],[false,600000,4],[false,601000,4]]) {
  test(`更新按鈕: ${manual?'manual 60-second':'automatic ten-minute'} throttle at ${elapsed/1000}s sends ${expected} requests`, t=>{
    const f=fixture(t); oauthMock(f,429,headersAt());
    const args=manual?['--refresh','--manual']:['--refresh'];
    assert.equal(JSON.parse(f.run(...args)).claude.official.fiveHour.usedPercent,39);
    const statePath=path.join(f.install,'.cache/claude-oauth-poll.json');
    const state=JSON.parse(fs.readFileSync(statePath));
    state.startedAt=Date.now()-elapsed;
    state.longLivedStartedAt=state.startedAt;
    fs.writeFileSync(statePath,JSON.stringify(state));
    assert.equal(JSON.parse(f.run(...args)).claude.official.fiveHour.usedPercent,39);
    assert.equal(Number(fs.readFileSync(path.join(f.home,'request-count'))),expected);
    const next=JSON.parse(fs.readFileSync(statePath));
    assert.equal(next.attemptId===state.attemptId,expected===2);
  });
}
test('更新按鈕: manual refresh cannot replace a 61-second in-progress attempt',t=>{
  const f=fixture(t); oauthMock(f,429,headersAt());
  const statePath=path.join(f.install,'.cache/claude-oauth-poll.json');
  fs.writeFileSync(statePath,JSON.stringify({attemptId:'active-attempt',state:'in_progress',startedAt:Date.now()-61000,longLivedStartedAt:Date.now()-61000}));
  assert.equal(JSON.parse(f.run('--manual','--refresh')).claude.official.available,false);
  assert.equal(fs.existsSync(path.join(f.home,'request-count')),false);
  assert.equal(JSON.parse(fs.readFileSync(statePath)).attemptId,'active-attempt');
});
test('更新按鈕: rejected manual attempt after 61 seconds invalidates the previous successful percentage',t=>{
  const f=fixture(t);f.claude.source='oauth_headers';f.claude.fiveHour.usedPercent=0;f.save();
  const statePath=path.join(f.install,'.cache/claude-oauth-poll.json');
  fs.writeFileSync(statePath,JSON.stringify({attemptId:f.claude.attemptId,state:'succeeded',startedAt:Date.now()-61000,longLivedStartedAt:Date.now()-61000}));
  f.mock(`readClaudeLongLivedLogin=()=> 'dummy'; fetch=async()=>({status:403});`);
  assert.equal(JSON.parse(f.run('--manual','--refresh')).claude.official.fiveHour.usedPercent,null);
  assert.equal(JSON.parse(f.run()).claude.official.fiveHour.usedPercent,null);
  assert.equal(JSON.parse(fs.readFileSync(statePath)).state,'failed');
});

// Fable 每週欄（2026-10-25）：每模型每週窗只有 oauth/usage 會回。
function scopedMock(f, {usageStatus = 200, usageBody = null, retryAfter = null, messagesStatus = 200} = {}) {
  f.mock(`
readClaudeLongLivedLogin = () => "dummy-offline-login";
fetch = async (url, options) => {
  const counter = path.join(HOME, url.endsWith("/api/oauth/usage") ? "usage-count" : "messages-count");
  fs.writeFileSync(counter, String(Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0) + 1));
  if (url.endsWith("/api/oauth/usage")) {
    if (${usageStatus} !== 200) return {status: ${usageStatus}, headers: new Headers(${JSON.stringify(retryAfter === null ? {} : {'retry-after': String(retryAfter)})})};
    return {status: 200, json: async () => (${JSON.stringify(usageBody)})};
  }
  if (${messagesStatus} !== 200) return {status: ${messagesStatus}, headers: new Headers({})};
  return {status: 200, headers: new Headers(${JSON.stringify(headersAt())})};
};`);
}
const count = (f, name) => fs.existsSync(path.join(f.home, name)) ? Number(fs.readFileSync(path.join(f.home, name))) : 0;
function limitsBody(label = 'Fable', percent = 25) {
  const iso = s => new Date(Date.now() + s * 1000).toISOString();
  return {limits: [
    {kind: 'session', group: 'session', percent: 34, resets_at: iso(3600)},
    {kind: 'weekly_all', group: 'weekly', percent: 37, resets_at: iso(86400)},
    {kind: 'weekly_scoped', group: 'weekly', percent, resets_at: iso(86400), scope: {model: {display_name: label}}},
  ]};
}
test('Fable 每週欄: oauth/usage 成功時填入每模型百分比與重置時間', t => {
  const f = fixture(t); scopedMock(f, {usageBody: limitsBody()});
  const data = JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.source, 'oauth_usage');
  assert.equal(data.claude.official.fiveHour.usedPercent, 34);
  assert.equal(data.claude.official.weekAll.usedPercent, 37);
  assert.equal(data.claude.official.weekScoped.usedPercent, 25);
  assert.ok(data.claude.official.weekScoped.resetsAt > Date.now() / 1000);
  assert.equal(count(f, 'messages-count'), 0);
  assert.match(f.run('--text'), /Fable 75%/);
});
test('Fable 每週欄: 標籤取自回傳的模型名稱，不寫死', t => {
  const f = fixture(t); scopedMock(f, {usageBody: limitsBody('Opus', 12)});
  const data = JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.weekScoped.label, 'Opus');
  assert.equal(data.claude.official.weekScoped.usedPercent, 12);
});
test('Fable 每週欄: 429 加上被拒絕的一輪不會復活舊的每模型數字', t => {
  const f = fixture(t); scopedMock(f, {usageBody: limitsBody()});
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.weekScoped.usedPercent, 25);
  const statePath = path.join(f.install, '.cache/claude-oauth-poll.json');
  const age = () => { const s = JSON.parse(fs.readFileSync(statePath)); s.startedAt = s.longLivedStartedAt = Date.now() - 601000; fs.writeFileSync(statePath, JSON.stringify(s)); };
  age(); scopedMock(f, {usageStatus: 429, messagesStatus: 403});
  const rejected = JSON.parse(f.run('--refresh-claude'));
  assert.equal(rejected.claude.official.available, false);
  assert.equal(rejected.claude.official.weekScoped.usedPercent, null);
  age(); scopedMock(f, {usageStatus: 429});
  const headersOnly = JSON.parse(f.run('--refresh-claude'));
  assert.equal(headersOnly.claude.official.fiveHour.usedPercent, 39);
  assert.equal(headersOnly.claude.official.weekScoped.usedPercent, null);
  assert.equal(JSON.parse(f.run()).claude.official.weekScoped.usedPercent, null);
});
test('Fable 每週欄: 限流時沿用上一次已驗證成功的每模型數字，最多 30 分鐘', t => {
  const f = fixture(t); scopedMock(f, {usageBody: limitsBody()});
  JSON.parse(f.run('--refresh-claude'));
  const statePath = path.join(f.install, '.cache/claude-oauth-poll.json');
  const cachePath = path.join(f.install, '.cache/claude-usage-percentages.json');
  const shift = (scopedAgeMs) => {
    const s = JSON.parse(fs.readFileSync(statePath)); s.startedAt = s.longLivedStartedAt = Date.now() - 601000; fs.writeFileSync(statePath, JSON.stringify(s));
    const c = JSON.parse(fs.readFileSync(cachePath)); c.weekScoped.fetchedAt = new Date(Date.now() - scopedAgeMs).toISOString(); fs.writeFileSync(cachePath, JSON.stringify(c));
  };
  shift(11 * 60000); scopedMock(f, {usageStatus: 429});
  const carried = JSON.parse(f.run('--refresh-claude'));
  assert.equal(carried.claude.official.source, 'oauth_headers');
  assert.equal(carried.claude.official.weekScoped.usedPercent, 25);
  assert.equal(carried.claude.official.weekScoped.label, 'Fable');
  shift(31 * 60000); scopedMock(f, {usageStatus: 429});
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.weekScoped.usedPercent, null);
});
test('Fable 每週欄: 429 的 retry-after 會被遵守，手動更新也不提早再問', t => {
  const f = fixture(t); scopedMock(f, {usageStatus: 429, retryAfter: 1200});
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.fiveHour.usedPercent, 39);
  const statePath = path.join(f.install, '.cache/claude-oauth-poll.json');
  const s = JSON.parse(fs.readFileSync(statePath));
  assert.ok(s.usageRetryAt > Date.now() + 1100000 && s.usageRetryAt < Date.now() + 1300000);
  s.startedAt = s.longLivedStartedAt = Date.now() - 61000; fs.writeFileSync(statePath, JSON.stringify(s));
  assert.equal(JSON.parse(f.run('--refresh', '--manual')).claude.official.fiveHour.usedPercent, 39);
  assert.equal(count(f, 'usage-count'), 1);
  assert.equal(count(f, 'messages-count'), 2);
  const after = JSON.parse(fs.readFileSync(statePath));
  assert.equal(after.usageRetryAt, s.usageRetryAt);
  after.usageRetryAt = Date.now() - 1000; after.startedAt = after.longLivedStartedAt = Date.now() - 601000; fs.writeFileSync(statePath, JSON.stringify(after));
  scopedMock(f, {usageBody: limitsBody()});
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.weekScoped.usedPercent, 25);
  assert.equal(count(f, 'usage-count'), 2);
  assert.equal(JSON.parse(fs.readFileSync(statePath)).usageRetryAt, undefined);
  const stored = fs.readFileSync(statePath, 'utf8') + fs.readFileSync(path.join(f.install, '.cache/claude-usage-percentages.json'), 'utf8');
  assert.doesNotMatch(stored, /dummy-offline-login/);
});
