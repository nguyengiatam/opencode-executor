#!/usr/bin/env node
'use strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, openSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AGY_BIN = process.env.AGY_BIN || 'agy';

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return process.cwd();
  }
}

function baseDir() {
  const root = repoRoot();
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12);
  const dir = join(homedir(), '.agy-executor', hash);
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}

function statePath(dir) { return join(dir, 'state.json'); }

function loadState(dir) {
  const p = statePath(dir);
  if (!existsSync(p)) return { jobs: [] };
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { jobs: [] }; }
}

function saveState(dir, state) {
  writeFileSync(statePath(dir), JSON.stringify(state, null, 2));
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function refreshStatuses(state) {
  for (const j of state.jobs) {
    if (j.status === 'running' && !pidAlive(j.pid)) j.status = 'finished';
  }
  return state;
}

function newJobId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

function firstNonFlag(args) {
  return args.find((a) => !a.startsWith('--')) || null;
}

// ---- exec ----------------------------------------------------------------
function parseExec(args) {
  const o = { background: true, resume: false, fresh: false, model: null, addDirs: [], timeout: '85m', quotaCheck: true, task: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--background') o.background = true;
    else if (a === '--wait') o.background = false;
    else if (a === '--resume') o.resume = true;
    else if (a === '--fresh') o.fresh = true;
    else if (a === '--model') o.model = args[++i];
    else if (a === '--add-dir') o.addDirs.push(args[++i]);
    else if (a === '--timeout') o.timeout = args[++i];
    else if (a === '--no-quota-check') o.quotaCheck = false;
    else o.task.push(a);
  }
  o.task = o.task.join(' ').trim();
  return o;
}

function buildAgyArgs(o, promptPath, jobDir) {
  const instruction = `Read the task described in the file ${promptPath} and complete it. `
    + `Follow the instructions exactly. Work inside the current repository unless told otherwise.`;
  const a = [
    `--print=${instruction}`,
    '--dangerously-skip-permissions',
    '--mode', 'accept-edits',
    '--print-timeout', o.timeout,
    '--add-dir', jobDir,
  ];
  if (o.model) a.push('--model', o.model);
  for (const d of o.addDirs) a.push('--add-dir', d);
  if (o.resume && !o.fresh) a.push('-c');
  return a;
}

function cmdExec(args) {
  const { root, dir } = baseDir();
  const o = parseExec(args);
  if (!o.task) { console.log('No task text provided. Usage: exec [flags] <task...>'); process.exit(1); }

  // An exhausted agy exits 0 with near-empty output, which reads as "ran but did
  // nothing". Catch it here instead of letting the job look like a silent success.
  if (o.quotaCheck) {
    const q = fetchQuota();
    if (q.ok && q.verdict === 'exhausted') {
      console.log('agy is out of quota — every model group is spent. Not dispatching.');
      console.log('');
      printQuotaTable(q);
      console.log('\nWait for the next reset above, use another executor, or re-run with --no-quota-check.');
      process.exit(1);
    }
  }

  const jobId = newJobId();
  const jobDir = join(dir, 'jobs', jobId);
  mkdirSync(jobDir, { recursive: true });
  const promptPath = join(jobDir, 'prompt.md');
  const outputPath = join(jobDir, 'output.log');
  writeFileSync(promptPath, `${o.task}\n`);

  const agyArgs = buildAgyArgs(o, promptPath, jobDir);
  const startedAt = new Date().toISOString();
  const taskLine = o.task.split('\n')[0].slice(0, 100);

  const state = loadState(dir);

  if (!o.background) {
    const res = spawnSync(AGY_BIN, agyArgs, { cwd: root, encoding: 'utf8', maxBuffer: 1e8 });
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    writeFileSync(outputPath, out);
    state.jobs.unshift({ jobId, pid: null, status: res.status === 0 ? 'finished' : 'failed', startedAt, mode: 'wait', task: taskLine, outputPath, promptPath });
    saveState(dir, state);
    console.log(out || '(agy produced no output)');
    console.log(`\nJob ${jobId} — ${res.status === 0 ? 'finished' : 'failed'}. Result: /agy-executor:result ${jobId}`);
    return;
  }

  const fd = openSync(outputPath, 'a');
  const child = spawn(AGY_BIN, agyArgs, { cwd: root, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();
  state.jobs.unshift({ jobId, pid: child.pid, status: 'running', startedAt, mode: 'background', task: taskLine, outputPath, promptPath });
  saveState(dir, state);
  console.log(`Dispatched agy job ${jobId} (pid ${child.pid}) in the background.`);
  console.log(`Task: ${taskLine}`);
  console.log(`Poll:   /agy-executor:status ${jobId}`);
  console.log(`Result: /agy-executor:result ${jobId}`);
  console.log(`Cancel: /agy-executor:cancel ${jobId}`);
}

// ---- status --------------------------------------------------------------
function tail(path, n) {
  if (!existsSync(path)) return '';
  const lines = readFileSync(path, 'utf8').split('\n');
  return lines.slice(-n).join('\n');
}

function cmdStatus(args) {
  const { dir } = baseDir();
  const state = refreshStatuses(loadState(dir));
  saveState(dir, state);
  const id = firstNonFlag(args);

  if (id) {
    const j = state.jobs.find((x) => x.jobId === id);
    if (!j) { console.log(`No job ${id} in this repository.`); return; }
    console.log(`Job ${j.jobId}`);
    console.log(`  status:  ${j.status}`);
    console.log(`  mode:    ${j.mode}`);
    console.log(`  pid:     ${j.pid ?? '-'}`);
    console.log(`  started: ${j.startedAt}`);
    console.log(`  task:    ${j.task}`);
    console.log(`  --- last output lines ---`);
    console.log(tail(j.outputPath, 20) || '(no output yet)');
    return;
  }

  if (state.jobs.length === 0) { console.log('No agy jobs in this repository yet.'); return; }
  console.log('| job id | status | mode | started | task |');
  console.log('|---|---|---|---|---|');
  for (const j of state.jobs.slice(0, 15)) {
    console.log(`| ${j.jobId} | ${j.status} | ${j.mode} | ${j.startedAt} | ${j.task} |`);
  }
}

// ---- result --------------------------------------------------------------
function cmdResult(args) {
  const { dir } = baseDir();
  const state = refreshStatuses(loadState(dir));
  saveState(dir, state);
  const id = firstNonFlag(args);
  const j = id ? state.jobs.find((x) => x.jobId === id) : state.jobs[0];
  if (!j) { console.log(id ? `No job ${id}.` : 'No jobs yet.'); return; }
  console.log(`Job ${j.jobId} — status ${j.status}`);
  if (j.status === 'running') console.log('(still running; output so far below)');
  console.log('--- output ---');
  console.log(existsSync(j.outputPath) ? readFileSync(j.outputPath, 'utf8') : '(no output)');
}

// ---- cancel --------------------------------------------------------------
function cmdCancel(args) {
  const { dir } = baseDir();
  const state = loadState(dir);
  const id = firstNonFlag(args) || (state.jobs.find((j) => j.status === 'running') || {}).jobId;
  const j = state.jobs.find((x) => x.jobId === id);
  if (!j) { console.log('No matching job to cancel.'); return; }
  if (!pidAlive(j.pid)) { j.status = j.status === 'running' ? 'finished' : j.status; saveState(dir, state); console.log(`Job ${j.jobId} is not running.`); return; }
  try { process.kill(-j.pid, 'SIGTERM'); } catch { try { process.kill(j.pid, 'SIGTERM'); } catch {} }
  j.status = 'cancelled';
  saveState(dir, state);
  console.log(`Cancelled job ${j.jobId} (pid ${j.pid}).`);
}

// ---- quota ---------------------------------------------------------------
// agy exposes real quota through its own `/quota` slash command, which is
// expanded in print mode and costs zero model tokens (usage.total_tokens == 0).
// `--output-format json` wraps it as { command: { data: { groups: [...] } } }.
function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s === -1 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

function fetchQuota() {
  const res = spawnSync(AGY_BIN, ['--print=/quota', '--output-format', 'json', '--print-timeout', '1m'], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 1e7,
  });
  if (res.error) return { ok: false, error: res.error.message, raw: '' };
  const raw = `${res.stdout || ''}${res.stderr || ''}`;
  const parsed = extractJson(raw);
  const groups = parsed?.command?.data?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    // Older agy builds print the plain TSV without the structured command payload.
    return { ok: false, error: 'could not parse a quota payload from agy', raw };
  }
  const norm = groups.map((g) => ({
    name: g.name,
    description: g.description || '',
    buckets: (g.buckets || []).map((b) => ({
      id: b.id,
      name: b.name,
      window: b.window,
      remainingFraction: typeof b.remaining_fraction === 'number' ? b.remaining_fraction : null,
      resetTime: b.reset_time || null,
      detail: b.description || '',
    })),
  }));
  const spent = (g) => g.buckets.some((b) => b.remainingFraction === 0);
  const verdict = norm.every(spent) ? 'exhausted' : (norm.some(spent) ? 'partial' : 'ok');
  return { ok: true, verdict, groups: norm, note: parsed?.command?.data?.description || '' };
}

function untilText(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '-';
  let s = Math.max(0, Math.round((t - Date.now()) / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (!d && m) parts.push(`${m}m`);
  return parts.length ? `in ${parts.join(' ')}` : 'now';
}

function pct(f) {
  if (f === null) return '-';
  const v = f * 100;
  return `${v >= 99.95 ? '100' : v.toFixed(1)}%`;
}

function printQuotaTable(q) {
  console.log('| group | window | remaining | resets |');
  console.log('|---|---|---|---|');
  for (const g of q.groups) {
    for (const b of g.buckets) {
      const reset = b.resetTime ? `${untilText(b.resetTime)} (${new Date(b.resetTime).toLocaleString()})` : '-';
      console.log(`| ${g.name} | ${b.window || b.name} | ${pct(b.remainingFraction)} | ${reset} |`);
    }
  }
}

function cmdQuota(args) {
  const q = fetchQuota();
  if (args.includes('--json')) { console.log(JSON.stringify(q, null, 2)); return; }
  if (!q.ok) {
    console.log(`Could not read agy quota: ${q.error}`);
    if (q.raw) { console.log('--- agy output ---'); console.log(q.raw.slice(0, 800)); }
    process.exit(1);
  }
  console.log(`agy quota — verdict: ${q.verdict}`);
  console.log('');
  printQuotaTable(q);
  for (const g of q.groups) {
    if (g.description) console.log(`\n${g.name}: ${g.description}`);
  }
  if (q.note) console.log(`\n${q.note}`);
}

// ---- setup ---------------------------------------------------------------
function cmdSetup(args) {
  const json = args.includes('--json');
  const which = spawnSync('sh', ['-c', `command -v ${AGY_BIN}`], { encoding: 'utf8' });
  const installed = which.status === 0 && which.stdout.trim().length > 0;
  const q = installed ? fetchQuota() : { ok: false, error: 'agy is not installed' };
  const quota = installed ? (q.ok ? q.verdict : 'unknown') : 'unknown';

  if (json) {
    console.log(JSON.stringify({
      agyPath: installed ? which.stdout.trim() : null,
      installed,
      quota,
      groups: q.ok ? q.groups : [],
      error: q.ok ? null : q.error,
    }, null, 2));
    return;
  }

  console.log(`agy installed: ${installed ? which.stdout.trim() : 'NO — install the Antigravity CLI'}`);
  console.log(`quota: ${quota}`);
  if (q.ok) {
    console.log('');
    printQuotaTable(q);
    if (q.verdict === 'exhausted') console.log('\nEvery model group is spent. Wait for the next reset above, or use another executor.');
    else if (q.verdict === 'partial') console.log('\nOne model group is spent. Pass --model to pick a group that still has room.');
  } else if (installed) {
    console.log(`Could not read quota: ${q.error}`);
  }
}

// ---- resume-candidate ----------------------------------------------------
function cmdResumeCandidate(args) {
  const { dir } = baseDir();
  const state = loadState(dir);
  const j = state.jobs[0];
  const report = { available: !!j, jobId: j ? j.jobId : null };
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else console.log(report.available ? `Resumable: last job ${report.jobId}` : 'No resumable agy work in this repository.');
}

// ---- dispatch ------------------------------------------------------------
const [sub, ...rest] = process.argv.slice(2);
const table = {
  exec: cmdExec,
  status: cmdStatus,
  result: cmdResult,
  cancel: cmdCancel,
  setup: cmdSetup,
  quota: cmdQuota,
  'resume-candidate': cmdResumeCandidate,
};
if (!sub || !table[sub]) {
  console.log('Usage: agy-runtime.mjs <exec|status|result|cancel|setup|quota|resume-candidate> [args]');
  process.exit(sub ? 1 : 0);
}
table[sub](rest);
