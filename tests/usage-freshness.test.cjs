const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const installer = fs.readFileSync(path.join(__dirname, '../agent-usage-widget-skill/scripts/install-agent-usage-widget.sh'), 'utf8');
// 機器很忙時可用 USAGE_TEST_TIMEOUT_MS 放寬每次執行的逾時（預設 5 秒）。
const RUN_TIMEOUT = Number(process.env.USAGE_TEST_TIMEOUT_MS) || 5000;
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
// 離線測試絕不讀真的鑰匙圈：預設把 CLI 登入視為與長效登入同一組假權杖、未過期、有 user:profile。
const realReadClaudeCliLogin = readClaudeCliLogin;
readClaudeCliLogin = () => { const token = readClaudeLongLivedLogin(); return token ? {accessToken: token, expiresAt: Date.now() + 3600000, hasProfileScope: true, hasRefresh: true} : {accessToken: "", expiresAt: null, hasProfileScope: false, hasRefresh: false}; };
const realResolveClaudeCliPath = resolveClaudeCliPath;
resolveClaudeCliPath = () => null;
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
  const run = (...args) => execFileSync(process.execPath, [script, '--quota-only', ...args], {env:{HOME:home,PATH:'/usr/bin:/bin'}, encoding:'utf8', timeout:RUN_TIMEOUT});
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
  // 接手一個沒留下任何等待期限的失聯嘗試：等待未知，本輪只用標頭（1 次請求）。
  assert.equal(Number(fs.readFileSync(path.join(f.home,'request-count'))),1);
  // 下一輪恢復正常：官方用量＋標頭。
  const statePath=path.join(f.install,'.cache/claude-oauth-poll.json');
  const s=JSON.parse(fs.readFileSync(statePath)); s.startedAt=s.longLivedStartedAt=Date.now()-601000; fs.writeFileSync(statePath,JSON.stringify(s));
  f.run('--refresh-claude');
  assert.equal(Number(fs.readFileSync(path.join(f.home,'request-count'))),3);
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
// 以固定時間執行：在腳本最前面覆寫 Date，讓 Date.now() 與 new Date() 一致可控。
function runAt(f, at, ...args) {
  const timed = f.script.replace(/\.js$/, '.timed.js');
  const prefix = `{ const RealDate = Date; const fixed = Number(process.env.FAKE_NOW);
global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } }; }\n`;
  const body = fs.readFileSync(f.script, 'utf8');
  const shebang = body.startsWith('#!') ? body.slice(0, body.indexOf('\n') + 1) : '';
  fs.writeFileSync(timed, shebang + prefix + body.slice(shebang.length));
  return execFileSync(process.execPath, [timed, '--quota-only', ...args], {env: {HOME: f.home, PATH: '/usr/bin:/bin', FAKE_NOW: String(at)}, encoding: 'utf8', timeout: RUN_TIMEOUT});
}
const failureMocks = {
  401: f => scopedMock(f, {usageStatus: 401}),
  403: f => scopedMock(f, {usageStatus: 403}),
  429: f => scopedMock(f, {usageStatus: 429}),
  500: f => scopedMock(f, {usageStatus: 500}),
  invalid: f => f.mock(`readClaudeLongLivedLogin = () => "dummy";
fetch = async url => url.endsWith('/api/oauth/usage') ? {status: 200, json: async () => { throw new Error('bad'); }} : {status: 200, headers: new Headers(${JSON.stringify(headersAt())})};`),
  connection: f => f.mock(`readClaudeLongLivedLogin = () => "dummy";
fetch = async url => { if (url.endsWith('/api/oauth/usage')) throw new Error('offline'); return {status: 200, headers: new Headers(${JSON.stringify(headersAt())})}; };`),
};
for (const [name, failWith] of Object.entries(failureMocks)) {
  test(`Fable 每週欄: 成功後 11 分鐘遇到 ${name}，舊的每模型數字不得復活`, t => {
    const f = fixture(t); const t0 = Date.now();
    fs.rmSync(path.join(f.install, '.cache/claude-oauth-poll.json'));
    scopedMock(f, {usageBody: limitsBody()});
    assert.equal(JSON.parse(runAt(f, t0, '--refresh-claude')).claude.official.weekScoped.usedPercent, 25);
    failWith(f);
    const later = t0 + 11 * 60000;
    const data = JSON.parse(runAt(f, later, '--refresh-claude'));
    assert.equal(data.claude.official.source, 'oauth_headers');
    assert.equal(data.claude.official.fiveHour.usedPercent, 39);
    assert.equal(data.claude.official.weekScoped.usedPercent, null);
    assert.equal(data.claude.official.weekScoped.resetsAt, null);
    assert.equal(data.claude.official.weekScoped.label, 'Fable');
    assert.equal(JSON.parse(runAt(f, later + 1000)).claude.official.weekScoped.usedPercent, null);
  });
}
for (const scopedFetchedAt of [undefined, 35 * 60000]) {
  test(`舊快取相容: 上一版標頭快取含模型數字（模型觀測時間 ${scopedFetchedAt === undefined ? '缺' : '35 分鐘前'}）交給新版讀，數字不出現`, t => {
    const f = fixture(t, 6 * 60000);
    f.claude.source = 'oauth_headers';
    f.claude.weekScoped = {usedPercent: 25, resetsAt: Date.now() / 1000 + 86400, label: 'Fable',
      ...(scopedFetchedAt !== undefined && {fetchedAt: new Date(Date.now() - scopedFetchedAt).toISOString()})};
    f.save();
    fs.writeFileSync(path.join(f.install, '.cache/claude-oauth-poll.json'), JSON.stringify({attemptId: f.claude.attemptId, state: 'succeeded', startedAt: Date.now() - 6 * 60000}));
    const data = JSON.parse(f.run());
    assert.equal(data.claude.official.available, true);
    assert.equal(data.claude.official.weekAll.usedPercent, 37);
    assert.equal(data.claude.official.weekScoped.usedPercent, null);
    assert.equal(data.claude.official.weekScoped.label, 'Fable');
  });
}
test('舊快取相容: 官方用量來源的模型欄若帶超過 10 分鐘的自身觀測時間也清空', t => {
  const f = fixture(t, 60000); f.claude.source = 'oauth_usage';
  f.claude.weekScoped.fetchedAt = new Date(Date.now() - 11 * 60000).toISOString(); f.save();
  assert.equal(JSON.parse(f.run()).claude.official.weekScoped.usedPercent, null);
  f.claude.weekScoped.fetchedAt = new Date(Date.now() - 60000).toISOString(); f.save();
  assert.equal(JSON.parse(f.run()).claude.official.weekScoped.usedPercent, 1);
});
function retryFailureRun(f, inject) {
  f.mock(`readClaudeLongLivedLogin = () => "dummy";
readClaudeDesktopSession = () => ({orgId: 'dummy', cookieHeader: 'dummy'});
${inject}
fetch = async url => {
  const counter = path.join(HOME, url.endsWith('/api/oauth/usage') ? 'usage-count' : url.startsWith('https://claude.ai/') ? 'cookie-count' : 'messages-count');
  fs.writeFileSync(counter, String(Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1));
  if (url.endsWith('/api/oauth/usage')) { if (typeof beforeRetry === 'function') beforeRetry(); return {status: 429, headers: new Headers({'retry-after': '3600'})}; }
  return {status: 200, ok: true, headers: new Headers(${JSON.stringify(headersAt())}), json: async () => ({five_hour: {utilization: 39, resets_at: nowMs / 1000 + 3600}})};
};`);
}
function restartAfterLease(f) {
  const statePath = path.join(f.install, '.cache/claude-oauth-poll.json');
  const s = JSON.parse(fs.readFileSync(statePath));
  s.startedAt = s.longLivedStartedAt = Date.now() - 601000; fs.writeFileSync(statePath, JSON.stringify(s));
  retryFailureRun(f, '');
  f.run('--refresh-claude');
  assert.equal(count(f, 'usage-count'), 1);
  assert.equal(count(f, 'cookie-count'), 0);
}
test('429 保存: 輪詢狀態寫入失敗但個別紀錄成功，本輪只用標頭、重啟 10 分鐘仍不查官方用量', t => {
  const f = fixture(t);
  retryFailureRun(f, `const realWrite = writeClaudePollState;
writeClaudePollState = state => { if (Number.isFinite(state.usageRetryAt) && state.state === 'in_progress') throw new Error('disk full'); return realWrite(state); };`);
  const data = JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.fiveHour.usedPercent, 39);
  assert.equal(count(f, 'messages-count'), 1);
  assert.equal(count(f, 'cookie-count'), 0);
  assert.equal(fs.readdirSync(path.join(f.install, '.cache/claude-retry')).length, 1);
  restartAfterLease(f);
});
test('429 保存: 鎖被占用超過 1 秒但個別紀錄成功，重啟 10 分鐘仍不查官方用量', t => {
  const f = fixture(t);
  retryFailureRun(f, `beforeRetry = () => fs.mkdirSync(CLAUDE_POLL_STATE + '.lock');`);
  f.run('--refresh-claude');
  assert.equal(count(f, 'cookie-count'), 0);
  fs.rmdirSync(path.join(f.install, '.cache/claude-oauth-poll.json.lock'));
  restartAfterLease(f);
});
test('429 保存: 個別紀錄與輪詢狀態都寫不進時本輪立即停止，失聯接手時保守跳過官方用量一次', t => {
  const f = fixture(t);
  retryFailureRun(f, `writeClaudeRetryMarker = () => false;
const realWrite = writeClaudePollState;
writeClaudePollState = state => { if (Number.isFinite(state.usageRetryAt)) throw new Error('disk full'); return realWrite(state); };`);
  const data = JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.error, 'retry_persist_failed');
  assert.equal(count(f, 'messages-count'), 0);
  assert.equal(count(f, 'cookie-count'), 0);
  const statePath = path.join(f.install, '.cache/claude-oauth-poll.json');
  const s = JSON.parse(fs.readFileSync(statePath));
  assert.equal(s.state, 'in_progress');
  assert.equal(s.usageRetryAt, undefined);
  restartAfterLease(f);
  assert.equal(count(f, 'messages-count'), 1);
});
test('429 保存: 所有權已更換且個別紀錄寫失敗時不得回成功', t => {
  const f = fixture(t);
  f.mock(`writeClaudeRetryMarker = () => false;
main = async () => {
  writeClaudePollState({attemptId: 'someone-else', state: 'in_progress', startedAt: Date.now()});
  const lost = persistClaudeRetryAt({attemptId: 'mine'}, Date.now() + 3600000);
  writeClaudeRetryMarker = (...a) => realMarker(...a);
  const kept = persistClaudeRetryAt({attemptId: 'mine2'}, Date.now() + 3600000);
  process.stdout.write(JSON.stringify({lost, kept}));
};`);
  // 第二次呼叫要用真的寫檔函式：在注入前先保存原函式。
  const script = fs.readFileSync(f.script, 'utf8').replace('writeClaudeRetryMarker = () => false;', 'const realMarker = writeClaudeRetryMarker; writeClaudeRetryMarker = () => false;');
  fs.writeFileSync(f.script, script);
  assert.deepEqual(JSON.parse(f.run()), {lost: false, kept: true});
});
test('429 保存: 兩程序交錯時舊程序較短的期限不會蓋掉較晚的六小時期限', t => {
  const f = fixture(t);
  const sixHours = Date.now() + 6 * 3600000;
  const withMain = code => { f.mock(`main = async () => { ${code} };`); return fs.readFileSync(f.script, 'utf8'); };
  // B：另一個程序，寫入六小時期限。
  const bScript = f.script.replace(/\.js$/, '.b.js');
  fs.writeFileSync(bScript, withMain(`if (!writeClaudeRetryMarker('B-attempt', ${sixHours})) process.exit(3);`));
  // A：先讀到舊值（無）後暫停，期間 B 完整執行，A 恢復後寫入自己較短的一小時期限。
  withMain(`const before = readClaudeRetryMarker();
require('child_process').execFileSync(process.execPath, [${JSON.stringify(bScript)}], {env: process.env, stdio: 'ignore'});
const wrote = writeClaudeRetryMarker('A-attempt', Date.now() + 3600000);
process.stdout.write(JSON.stringify({before, wrote}));`);
  assert.deepEqual(JSON.parse(f.run()), {before: null, wrote: true});
  withMain(`process.stdout.write(JSON.stringify(readClaudeRetryMarker()));`);
  assert.equal(JSON.parse(f.run()), sixHours);
  // 同一嘗試重寫同一期限不會出錯；過期紀錄讀取時順手刪除，不影響六小時。
  withMain(`writeClaudeRetryMarker('C-attempt', Date.now() - 1000); process.stdout.write(JSON.stringify(writeClaudeRetryMarker('B-attempt', ${sixHours})));`);
  assert.equal(JSON.parse(f.run()), true);
  withMain(`process.stdout.write(JSON.stringify(readClaudeRetryMarker()));`);
  assert.equal(JSON.parse(f.run()), sixHours);
  assert.equal(fs.readdirSync(path.join(f.install, '.cache/claude-retry')).length, 2);
});
test('便宜 P2: 模型百分比只收 0～100，名稱含換行或控制字元改中性名稱', t => {
  const iso = s => new Date(Date.now() + s * 1000).toISOString();
  const f = fixture(t); scopedMock(f, {usageBody: {limits: [
    {kind: 'session', percent: 34, resets_at: iso(3600)},
    {kind: 'weekly_scoped', percent: 150, resets_at: iso(86400), scope: {model: {display_name: 'Opus'}}},
    {kind: 'weekly_scoped', percent: -1, resets_at: iso(86400), scope: {model: {display_name: 'Haiku'}}},
    {kind: 'weekly_scoped', percent: 25, resets_at: iso(86400), scope: {model: {display_name: 'Fa\nble'}}},
  ]}});
  const data = JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.weekScoped.usedPercent, 25);
  assert.equal(data.claude.official.weekScoped.label, '模型');
  const g = fixture(t); scopedMock(g, {usageBody: {limits: [
    {kind: 'session', percent: 34, resets_at: iso(3600)},
    {kind: 'weekly_scoped', percent: 150, resets_at: iso(86400), scope: {model: {display_name: 'Fable\u0007'}}},
  ]}});
  const only = JSON.parse(g.run('--refresh-claude'));
  assert.equal(only.claude.official.weekScoped.usedPercent, null);
  assert.equal(only.claude.official.weekScoped.label, '模型');
});
test('Fable 每週欄: 收到 429 後立即中止，再啟動 10 分鐘後仍不得查詢官方用量與網頁登入', t => {
  const f = fixture(t);
  f.mock(`readClaudeLongLivedLogin = () => "dummy";
fetch = async url => {
  const counter = path.join(HOME, url.endsWith('/api/oauth/usage') ? 'usage-count' : 'messages-count');
  fs.writeFileSync(counter, String(Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1));
  if (url.endsWith('/api/oauth/usage')) return {status: 429, headers: new Headers({'retry-after': '3600'})};
  process.exit(9);
};`);
  assert.throws(() => f.run('--refresh-claude'));
  const statePath = path.join(f.install, '.cache/claude-oauth-poll.json');
  const s = JSON.parse(fs.readFileSync(statePath));
  assert.equal(s.state, 'in_progress');
  assert.ok(s.usageRetryAt > Date.now() + 3500000);
  s.startedAt = s.longLivedStartedAt = Date.now() - 601000; fs.writeFileSync(statePath, JSON.stringify(s));
  f.mock(`readClaudeLongLivedLogin = () => "dummy";
readClaudeDesktopSession = () => ({orgId: 'dummy', cookieHeader: 'dummy'});
fetch = async url => {
  const counter = path.join(HOME, url.endsWith('/api/oauth/usage') ? 'usage-count' : url.startsWith('https://claude.ai/') ? 'cookie-count' : 'messages-count');
  fs.writeFileSync(counter, String(Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0) + 1));
  return {status: 403, ok: false, headers: new Headers({})};
};`);
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.available, false);
  assert.equal(count(f, 'usage-count'), 1);
  assert.equal(count(f, 'cookie-count'), 0);
  assert.ok(JSON.parse(fs.readFileSync(statePath)).usageRetryAt >= s.usageRetryAt);
});
test('Fable 每週欄: retry-after 只把非負整數當秒數，其餘試日期，上限 6 小時', t => {
  for (const [value, low, high] of [['120', 110e3, 130e3], ['1e3', null, null], ['0x10', null, null], ['1.5', null, null], ['99999999', 6*3600e3-10e3, 6*3600e3+10e3]]) {
    const f = fixture(t); scopedMock(f, {usageStatus: 429, retryAfter: value});
    f.run('--refresh-claude');
    const s = JSON.parse(fs.readFileSync(path.join(f.install, '.cache/claude-oauth-poll.json')));
    if (low === null) assert.equal(s.usageRetryAt, undefined, value);
    else assert.ok(s.usageRetryAt - Date.now() > low && s.usageRetryAt - Date.now() < high, value);
  }
  const f = fixture(t); scopedMock(f, {usageStatus: 429, retryAfter: new Date(Date.now() + 900000).toUTCString()});
  f.run('--refresh-claude');
  const s = JSON.parse(fs.readFileSync(path.join(f.install, '.cache/claude-oauth-poll.json')));
  assert.ok(s.usageRetryAt - Date.now() > 880000 && s.usageRetryAt - Date.now() < 910000);
});
test('Fable 每週欄: 多筆模型取第一筆有效的；名稱非字串或過長改中性名稱', t => {
  const iso = s => new Date(Date.now() + s * 1000).toISOString();
  const body = {limits: [
    {kind: 'session', percent: 34, resets_at: iso(3600)},
    {kind: 'weekly_scoped', percent: 50, resets_at: iso(-60), scope: {model: {display_name: 'Opus'}}},
    {kind: 'weekly_scoped', percent: 25, resets_at: iso(86400), scope: {model: {display_name: {text: 'x'}}}},
  ]};
  const f = fixture(t); scopedMock(f, {usageBody: body});
  const data = JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.weekScoped.usedPercent, 25);
  assert.equal(data.claude.official.weekScoped.label, '模型');
  const cache = JSON.parse(fs.readFileSync(path.join(f.install, '.cache/claude-usage-percentages.json')));
  assert.equal(cache.weekScoped.label, '模型');
  const g = fixture(t); scopedMock(g, {usageBody: limitsBody('X'.repeat(33), 10)});
  assert.equal(JSON.parse(g.run('--refresh-claude', '--lang=en')).claude.official.weekScoped.label, 'Model');
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
  fs.rmSync(path.join(f.install, '.cache/claude-retry'), {recursive: true, force: true});
  scopedMock(f, {usageBody: limitsBody()});
  assert.equal(JSON.parse(f.run('--refresh-claude')).claude.official.weekScoped.usedPercent, 25);
  assert.equal(count(f, 'usage-count'), 2);
  assert.equal(JSON.parse(fs.readFileSync(statePath)).usageRetryAt, undefined);
  const stored = fs.readFileSync(statePath, 'utf8') + fs.readFileSync(path.join(f.install, '.cache/claude-usage-percentages.json'), 'utf8');
  assert.doesNotMatch(stored, /dummy-offline-login/);
});
test('Codex 官方查詢: 禁止自動轉址，錯誤只輸出固定代碼', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, '.codex'), {recursive: true});
  fs.writeFileSync(path.join(f.home, '.codex/auth.json'), JSON.stringify({tokens: {access_token: 'fake-secret-token', account_id: 'fake-account-id'}}));
  f.mock(`fetch = async (url, options) => {
  fs.writeFileSync(path.join(HOME, 'codex-redirect'), String(options.redirect));
  throw new Error('boom fake-secret-token fake-account-id');
};
main = async () => { process.stdout.write(JSON.stringify(await fetchCodexOfficialUsage({force: true}))); };`);
  const out = f.run();
  assert.equal(fs.readFileSync(path.join(f.home, 'codex-redirect'), 'utf8'), 'manual');
  assert.doesNotMatch(out, /fake-secret-token|fake-account-id|boom/);
  assert.match(out, /"error":"(unavailable|live_unavailable)"/);
});

// CLI 登入（鑰匙圈）查 Fable 與手動重新整理時讓 CLI 自己續期（2026-10-26）。全離線：假鑰匙圈檔＋假 CLI 腳本。
function cliFixture(t, {expired = true, hasRefresh = true, profile = true, cli = 'renew'} = {}) {
  const f = fixture(t);
  const keychain = path.join(f.home, 'fake-keychain.json');
  const login = (fresh) => ({accessToken: fresh ? 'fake-cli-fresh-token' : 'fake-cli-old-token', expiresAt: fresh ? Date.now() + 3600000 : Date.now() - 60000,
    scopes: profile ? ['user:inference', 'user:profile'] : ['user:inference'], refreshToken: hasRefresh ? 'fake-refresh-secret' : ''});
  fs.writeFileSync(keychain, JSON.stringify(login(!expired)));
  const script = path.join(f.home, 'fake-claude');
  const fresh = JSON.stringify(login(true)).replace(/'/g, "'\\''");
  const body = {
    renew: `#!/bin/sh\nenv > "$HOME/cli-env.txt"\npwd > "$HOME/cli-cwd.txt"\necho "$@" > "$HOME/cli-args.txt"\necho run >> "$HOME/cli-runs.txt"\nprintf '%s' '${fresh}' > "$HOME/fake-keychain.json"\necho 'fake-refresh-secret fake-cli-fresh-token' \n`,
    hang: `#!/bin/sh\necho run >> "$HOME/cli-runs.txt"\nexec /bin/sleep 30\n`,
  }[cli];
  fs.writeFileSync(script, body, {mode: 0o755});
  fs.writeFileSync(path.join(f.install, 'claude-path'), script + '\n');
  f.cliMock = (extra = '') => f.mock(`readClaudeLongLivedLogin = () => "dummy-long-lived";
resolveClaudeCliPath = realResolveClaudeCliPath;
CLAUDE_CLI_RENEW_TIMEOUT_MS = ${cli === 'hang' ? 3000 : 30000};
// 只替換外部命令層：正式的 readClaudeCliLogin 解析 claudeAiOauth 包裝。
readClaudeCliLogin = realReadClaudeCliLogin;
readClaudeKeychainRaw = () => JSON.stringify({claudeAiOauth: JSON.parse(fs.readFileSync(path.join(HOME, 'fake-keychain.json'), 'utf8'))});
${extra}
fetch = async (url, options) => {
  const name = url.endsWith('/api/oauth/usage') ? 'usage' : 'messages';
  fs.appendFileSync(path.join(HOME, name + '-auth.txt'), options.headers.authorization + '\\n');
  if (name === 'usage') return {status: 200, json: async () => (${JSON.stringify(limitsBody())})};
  return {status: 200, headers: new Headers(${JSON.stringify(headersAt())})};
};`);
  f.cliMock();
  f.runs = () => fs.existsSync(path.join(f.home, 'cli-runs.txt')) ? fs.readFileSync(path.join(f.home, 'cli-runs.txt'), 'utf8').trim().split('\n').length : 0;
  f.lines = name => fs.existsSync(path.join(f.home, name)) ? fs.readFileSync(path.join(f.home, name), 'utf8').trim().split('\n') : [];
  return f;
}
test('CLI 登入: 過期時手動重新整理叫 CLI 續期，再讀鑰匙圈後官方用量成功、Fable 有數字', t => {
  const f = cliFixture(t);
  const data = JSON.parse(f.run('--refresh', '--manual'));
  assert.equal(f.runs(), 1);
  assert.equal(data.claude.official.source, 'oauth_usage');
  assert.equal(data.claude.official.weekScoped.usedPercent, 25);
  assert.equal(data.claude.official.weekScoped.label, 'Fable');
  assert.deepEqual(f.lines('usage-auth.txt'), ['Bearer fake-cli-fresh-token']);
  assert.deepEqual(f.lines('messages-auth.txt'), []);
});
test('CLI 登入: CLI 卡住超過逾時被結束，Fable 維持未知、5 小時與每週仍由標頭提供', t => {
  const f = cliFixture(t, {cli: 'hang'});
  const started = Date.now();
  const data = JSON.parse(f.run('--refresh', '--manual'));
  assert.ok(Date.now() - started < 25000); // 假 CLI 會睡 30 秒，代表已被逾時結束
  assert.equal(f.runs(), 1);
  assert.equal(data.claude.official.source, 'oauth_headers');
  assert.equal(data.claude.official.fiveHour.usedPercent, 39);
  assert.equal(data.claude.official.weekScoped.usedPercent, null);
  assert.deepEqual(f.lines('usage-auth.txt'), []);
  assert.deepEqual(f.lines('messages-auth.txt'), ['Bearer dummy-long-lived']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.install, '.cache/claude-oauth-poll.json'))).usageError, 'cli_login_expired');
});
test('CLI 登入: 權杖未過期時不叫 CLI，直接用鑰匙圈登入查官方用量', t => {
  const f = cliFixture(t, {expired: false});
  const data = JSON.parse(f.run('--refresh', '--manual'));
  assert.equal(f.runs(), 0);
  assert.equal(data.claude.official.weekScoped.usedPercent, 25);
  assert.deepEqual(f.lines('usage-auth.txt'), ['Bearer fake-cli-fresh-token']);
});
test('CLI 登入: 非手動重新整理即使過期也不叫 CLI', t => {
  const f = cliFixture(t);
  const data = JSON.parse(f.run('--refresh'));
  assert.equal(f.runs(), 0);
  assert.equal(data.claude.official.weekScoped.usedPercent, null);
  assert.equal(data.claude.official.fiveHour.usedPercent, 39);
});
test('CLI 登入: 10 分鐘冷卻內連按只叫一次 CLI', t => {
  const f = cliFixture(t, {cli: 'hang'});
  f.run('--refresh', '--manual');
  const statePath = path.join(f.install, '.cache/claude-oauth-poll.json');
  const s = JSON.parse(fs.readFileSync(statePath)); s.startedAt = s.longLivedStartedAt = Date.now() - 61000; fs.writeFileSync(statePath, JSON.stringify(s));
  f.run('--refresh', '--manual');
  assert.equal(f.runs(), 1);
  const renew = path.join(f.install, '.cache/claude-cli-renew.json');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(renew))), ['lastAttemptAt']);
  fs.writeFileSync(renew, JSON.stringify({lastAttemptAt: Date.now() - 601000}));
  const s2 = JSON.parse(fs.readFileSync(statePath)); s2.startedAt = s2.longLivedStartedAt = Date.now() - 61000; fs.writeFileSync(statePath, JSON.stringify(s2));
  f.run('--refresh', '--manual');
  assert.equal(f.runs(), 2);
});
for (const [name, opts, code] of [['沒有更新值', {hasRefresh: false}, 'cli_login_expired'], ['缺 user:profile', {expired: false, profile: false}, 'usage_scope_missing']]) {
  test(`CLI 登入: ${name}時不叫 CLI、不查官方用量`, t => {
    const f = cliFixture(t, opts);
    const data = JSON.parse(f.run('--refresh', '--manual'));
    assert.equal(f.runs(), 0);
    assert.deepEqual(f.lines('usage-auth.txt'), []);
    assert.equal(data.claude.official.weekScoped.usedPercent, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.install, '.cache/claude-oauth-poll.json'))).usageError, code);
  });
}
test('CLI 登入: 子程序環境不帶長效權杖與 API 金鑰，在新建後即刪的空暫存目錄執行，參數停用 hooks 與 MCP', t => {
  const f = cliFixture(t);
  execFileSync(process.execPath, [f.script, '--quota-only', '--refresh', '--manual'], {encoding: 'utf8', timeout: RUN_TIMEOUT,
    env: {HOME: f.home, PATH: '/usr/bin:/bin', CLAUDE_CODE_OAUTH_TOKEN: 'parent-long-lived-secret', ANTHROPIC_API_KEY: 'parent-api-key'}});
  const env = fs.readFileSync(path.join(f.home, 'cli-env.txt'), 'utf8');
  assert.doesNotMatch(env, /CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|parent-/);
  assert.match(env, /^PATH=\/usr\/bin:\/bin$/m);
  assert.match(env, /^CLAUDE_CODE_SAFE_MODE=1$/m);
  const cwd = fs.readFileSync(path.join(f.home, 'cli-cwd.txt'), 'utf8').trim();
  assert.match(path.basename(cwd), /^agent-usage-widget-renew-/);
  assert.notEqual(cwd, f.install);
  assert.equal(fs.existsSync(cwd), false);
  assert.equal(fs.readFileSync(path.join(f.home, 'cli-args.txt'), 'utf8').trim(),
    '-p ok --model haiku --safe-mode --settings {"disableAllHooks":true} --strict-mcp-config --mcp-config {"mcpServers":{}} --setting-sources local --disable-slash-commands --no-session-persistence');
});
test('CLI 登入: 假權杖、假更新值不出現在輸出與任何保存檔', t => {
  const f = cliFixture(t);
  const out = f.run('--refresh', '--manual') + f.run('--text') + f.run('--refresh', '--manual', '--text');
  assert.doesNotMatch(out, /fake-cli|fake-refresh|dummy-long-lived/);
  const walk = dir => fs.readdirSync(dir, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  for (const file of walk(path.join(f.install, '.cache'))) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /fake-cli|fake-refresh|dummy-long-lived/, file);
});
test('CLI 登入: 讀鑰匙圈失敗時不影響標頭來源', t => {
  const f = cliFixture(t);
  f.cliMock(`readClaudeKeychainRaw = () => { throw new Error('security exited 44'); };`);
  const data = JSON.parse(f.run('--refresh', '--manual'));
  assert.equal(f.runs(), 0);
  assert.equal(data.claude.official.fiveHour.usedPercent, 39);
  assert.equal(data.claude.official.weekScoped.usedPercent, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.install, '.cache/claude-oauth-poll.json'))).usageError, 'cli_login_missing');
});

test('CLI 登入: 續期時 hooks 不會執行（安裝資料夾與家目錄都放了會觸發的 hook 設定）', t => {
  const f = cliFixture(t);
  // 假 CLI（node 腳本）：只要「工作目錄或家目錄有 hook 設定」且「參數沒有停用 hooks」，就建立標記檔，模擬 hook 被執行。
  const script = path.join(f.home, 'fake-claude-hooks.js');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.writeFileSync(path.join(process.env.HOME, 'hook-args.json'), JSON.stringify({args, cwd: process.cwd()}));
const settings = [path.join(process.cwd(), '.claude/settings.local.json'), path.join(process.cwd(), '.claude/settings.json'), path.join(process.env.HOME, '.claude/settings.json')];
const hasHooks = settings.some(file => { try { return !!JSON.parse(fs.readFileSync(file, 'utf8')).hooks; } catch { return false; } });
const settingsArg = args.indexOf('--settings') >= 0 ? args[args.indexOf('--settings') + 1] : '';
let disabledBySetting = false; try { disabledBySetting = JSON.parse(settingsArg).disableAllHooks === true; } catch {}
const disabled = args.includes('--safe-mode') && disabledBySetting && process.env.CLAUDE_CODE_SAFE_MODE === '1';
if (hasHooks && !disabled) fs.writeFileSync(path.join(process.env.HOME, 'HOOK-RAN'), '1');
`, {mode: 0o755});
  fs.writeFileSync(path.join(f.install, 'claude-path'), script + '\n');
  const hook = JSON.stringify({hooks: {UserPromptSubmit: [{hooks: [{type: 'command', command: 'touch "$HOME/HOOK-RAN"'}]}]}});
  for (const dir of [path.join(f.install, '.claude'), path.join(f.home, '.claude')]) { fs.mkdirSync(dir, {recursive: true}); }
  fs.writeFileSync(path.join(f.install, '.claude/settings.local.json'), hook);
  fs.writeFileSync(path.join(f.home, '.claude/settings.json'), hook);
  f.run('--refresh', '--manual');
  const seen = JSON.parse(fs.readFileSync(path.join(f.home, 'hook-args.json'), 'utf8'));
  assert.equal(fs.existsSync(path.join(f.home, 'HOOK-RAN')), false);
  assert.notEqual(seen.cwd, f.install);
  assert.ok(seen.args.includes('--safe-mode'));
  // 反向對照：同一個假 CLI 在安裝資料夾、不帶停用參數時確實會留下標記，證明判斷邏輯有效。
  execFileSync(script, ['-p', 'ok'], {cwd: f.install, env: {HOME: f.home, PATH: '/usr/bin:/bin'}, timeout: RUN_TIMEOUT});
  assert.equal(fs.existsSync(path.join(f.home, 'HOOK-RAN')), true);
});
function keychainRun(t, inject) {
  const f = fixture(t);
  f.mock(`readClaudeCliLogin = realReadClaudeCliLogin;
${inject}
main = async () => { process.stdout.write(JSON.stringify(readClaudeCliLogin())); };`);
  return JSON.parse(f.run());
}
test('鑰匙圈解析: 正式解析 claudeAiOauth 包裝，只回四個欄位', t => {
  const r = keychainRun(t, `readClaudeKeychainRaw = () => JSON.stringify({claudeAiOauth: {accessToken: 'fake-a', expiresAt: 1893456000000, scopes: ['user:inference', 'user:profile'], refreshToken: 'fake-r', subscriptionType: 'max'}});`);
  assert.deepEqual(r, {accessToken: 'fake-a', expiresAt: 1893456000000, hasProfileScope: true, hasRefresh: true});
});
for (const [name, raw, expected] of [
  ['缺 claudeAiOauth', JSON.stringify({other: {}}), {accessToken: '', expiresAt: null, hasProfileScope: false, hasRefresh: false}],
  ['缺欄位', JSON.stringify({claudeAiOauth: {}}), {accessToken: '', expiresAt: null, hasProfileScope: false, hasRefresh: false}],
  ['型別錯', JSON.stringify({claudeAiOauth: {accessToken: 123, expiresAt: 'soon', scopes: 'user:profile', refreshToken: {x: 1}}}), {accessToken: '', expiresAt: null, hasProfileScope: false, hasRefresh: false}],
  ['不是 JSON', 'not-json', {accessToken: '', expiresAt: null, hasProfileScope: false, hasRefresh: false}],
]) {
  test(`鑰匙圈解析: ${name}時回空登入`, t => {
    assert.deepEqual(keychainRun(t, `readClaudeKeychainRaw = () => ${JSON.stringify(raw)};`), expected);
  });
}
test('鑰匙圈讀取: security 卡住且忽略終止訊號時，5 秒強制結束並回空登入', t => {
  const fake = path.join(fs.mkdtempSync(path.join(__dirname, '../.test-tmp/sec-')), 'security');
  t.after(() => fs.rmSync(path.dirname(fake), {recursive: true, force: true}));
  fs.writeFileSync(fake, "#!/bin/sh\ntrap '' TERM\nexec /bin/sleep 60\n", {mode: 0o755});
  const started = Date.now();
  const r = keychainRun(t, `CLAUDE_SECURITY_BIN = ${JSON.stringify(fake)};`);
  assert.deepEqual(r, {accessToken: '', expiresAt: null, hasProfileScope: false, hasRefresh: false});
  assert.ok(Date.now() - started < 30000, '必須在 sleep 60 之前結束');
});
