const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const installer = fs.readFileSync(path.join(__dirname, '../agent-usage-widget-skill/scripts/install-agent-usage-widget.sh'), 'utf8');
const source = installer.split("<<'NODE'\n")[1].split('\nNODE\n')[0];
function fixture(t, age = 0, expired = false) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-regression-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  const install = path.join(home, '.agent-usage-widget');
  fs.mkdirSync(path.join(install, '.cache'), {recursive: true});
  const script = path.join(install, 'summary.js');
  fs.writeFileSync(script, source);
  const fetchedAt = new Date(Date.now() - age).toISOString();
  const resetsAt = Date.now()/1000 + (expired ? -60 : 3600);
  const claude = {available: true, fetchedAt, fiveHour: {usedPercent: 100, resetsAt}, weekAll: {usedPercent: 37, resetsAt: Date.now()/1000+86400}, weekScoped: {usedPercent: 1, resetsAt: Date.now()/1000+86400, label: 'Fable'}};
  const codex = {available: true, fetchedAt, fiveHour: {usedPercent: 80, resetsAt}, week: {usedPercent: 11, resetsAt: Date.now()/1000+86400}};
  const save = () => { for (const [vendor, data] of Object.entries({claude,codex})) fs.writeFileSync(path.join(install, '.cache', vendor+'-usage-percentages.json'), JSON.stringify(data)); };
  const run = (...args) => execFileSync(process.execPath, [script, '--quota-only', ...args], {env:{HOME:home,PATH:'/usr/bin:/bin'}, encoding:'utf8', timeout:5000});
  save(); return {claude, codex, save, run, script};
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
  const mocked=source.replace('main().catch(', `readClaudeDesktopSession = () => ({orgId: "test", cookieHeader: "test=dummy"});
fetch = async () => ({ok: false, status: 403});
main().catch(`);
  fs.writeFileSync(f.script, mocked);
  const data=JSON.parse(f.run('--refresh-claude'));
  assert.equal(data.claude.official.available, false);
  assert.equal(data.claude.official.error, 'http_403');
  assert.equal(data.claude.official.fiveHour.usedPercent, null);
  assert.equal(data.claude.official.weekScoped.label, 'Fable');
  assert.match(f.run('--refresh-claude', '--text'), /Claude 讀取失敗：http_403/);
});
