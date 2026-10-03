#!/usr/bin/env node
'use strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, openSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode';

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
  const dir = join(homedir(), '.opencode-executor', hash);
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

function readEvents(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function eventSessionId(events) {
  return events.find((e) => e?.sessionID)?.sessionID || null;
}

function deriveStatus(job, events, exitCode = null) {
  const error = events.find((e) => e?.type === 'error');
  if (error) return { status: 'failed', error: error.error?.data?.message || error.error?.message || 'opencode reported an error' };
  if (job.status === 'timeout') return { status: 'timeout', error: null };
  if (events.length === 0) return { status: 'empty', error: null };
  const finishes = events.filter((e) => e?.type === 'step_finish');
  if (finishes.at(-1)?.part?.reason === 'stop') return { status: 'finished', error: null };
  if (exitCode !== null && exitCode !== 0) return { status: 'failed', error: `opencode exited with code ${exitCode}` };
  // opencode 2.x: bước cuối không phát step_finish 'stop' — tiến trình thoát 0 sau một khối text là xong.
  if ((exitCode === null || exitCode === 0) && events.at(-1)?.type === 'text') return { status: 'finished', error: null };
  return { status: 'incomplete', error: null };
}

function refreshStatuses(state) {
  for (const j of state.jobs) {
    const events = readEvents(j.outputPath);
    if (!j.sessionID) j.sessionID = eventSessionId(events);
    if (j.status !== 'running') continue;
    if (j.timeoutAt && Date.now() > Date.parse(j.timeoutAt)) {
      try { process.kill(-j.pid, 'SIGTERM'); } catch { try { process.kill(j.pid, 'SIGTERM'); } catch {} }
      j.status = 'timeout';
      continue;
    }
    if (!pidAlive(j.pid)) {
      const result = deriveStatus(j, events);
      j.status = result.status;
      if (result.error) j.error = result.error;
    }
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
  const o = { background: true, resume: false, fresh: false, model: null, timeout: '85m', task: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--background') o.background = true;
    else if (a === '--wait') o.background = false;
    else if (a === '--resume') o.resume = true;
    else if (a === '--fresh') o.fresh = true;
    else if (a === '--model') o.model = args[++i];
    else if (a === '--timeout') o.timeout = args[++i];
    else if (a === '--') { o.task.push(...args.slice(i + 1)); break; }
    else o.task.push(a);
  }
  o.task = o.task.join(' ').trim();
  return o;
}

function parseTimeout(value) {
  const m = /^(\d+(?:\.\d+)?)([smh])$/.exec(value);
  if (!m) throw new Error(`Invalid timeout: ${value}. Use forms like 90s, 30m, or 2h.`);
  const units = { s: 1000, m: 60000, h: 3600000 };
  return Number(m[1]) * units[m[2]];
}

function buildOpencodeArgs(o, root, sessionId) {
  const a = ['run', '--format', 'json', '--auto', '--standalone']; // opencode 2.x bỏ --dir: cwd của spawn là thư mục làm việc
  if (o.model) a.push('-m', o.model);
  if (sessionId) a.push('-s', sessionId);
  a.push('--', o.task);
  return a;
}

function cmdExec(args) {
  const { root, dir } = baseDir();
  const o = parseExec(args);
  if (!o.task) { console.log('No task text provided. Usage: exec [flags] <task...>'); process.exit(1); }
  let timeoutMs;
  try { timeoutMs = parseTimeout(o.timeout); } catch (e) { console.log(e.message); process.exit(1); }

  const state = loadState(dir);
  refreshStatuses(state);
  let sessionId = null;
  if (o.resume && !o.fresh) {
    const candidate = state.jobs.find((j) => j.sessionID);
    if (!candidate) { console.log('Nothing to resume in this repository.'); process.exit(1); }
    sessionId = candidate.sessionID;
  }

  const jobId = newJobId();
  const jobDir = join(dir, 'jobs', jobId);
  mkdirSync(jobDir, { recursive: true });
  const promptPath = join(jobDir, 'prompt.md');
  const outputPath = join(jobDir, 'output.jsonl');
  const stderrPath = join(jobDir, 'stderr.log');
  writeFileSync(promptPath, `${o.task}\n`);
  writeFileSync(outputPath, '');
  writeFileSync(stderrPath, '');
  const startedAt = new Date().toISOString();
  const timeoutAt = new Date(Date.now() + timeoutMs).toISOString();
  const taskLine = o.task.split('\n')[0].slice(0, 100);
  const opencodeArgs = buildOpencodeArgs(o, root, sessionId);
  const job = { jobId, pid: null, status: 'running', startedAt, timeoutAt, mode: o.background ? 'background' : 'wait', task: taskLine, model: o.model, sessionID: sessionId, outputPath, stderrPath, promptPath };

  if (!o.background) {
    const res = spawnSync(OPENCODE_BIN, opencodeArgs, {
      cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1e8,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(outputPath, res.stdout || '');
    writeFileSync(stderrPath, res.stderr || '');
    const events = readEvents(outputPath);
    job.sessionID = eventSessionId(events) || sessionId;
    if (res.error?.code === 'ETIMEDOUT') job.status = 'timeout';
    else job.status = deriveStatus(job, events, res.status).status;
    if (res.error && res.error.code !== 'ETIMEDOUT') job.error = res.error.message;
    else job.error = deriveStatus(job, events, res.status).error;
    state.jobs.unshift(job);
    saveState(dir, state);
    printResult(job);
    console.log(`\nJob ${jobId} — ${job.status}. Result: /opencode-executor:result ${jobId}`);
    if (job.status !== 'finished') { console.log('This run was not a success.'); process.exitCode = 1; }
    return;
  }

  const outFd = openSync(outputPath, 'a');
  const errFd = openSync(stderrPath, 'a');
  const child = spawn(OPENCODE_BIN, opencodeArgs, { cwd: root, detached: true, stdio: ['ignore', outFd, errFd] });
  child.unref();
  job.pid = child.pid;
  state.jobs.unshift(job);
  saveState(dir, state);
  console.log(`Dispatched opencode job ${jobId} (pid ${child.pid}) in the background.`);
  console.log(`Task: ${taskLine}`);
  console.log(`Poll:   /opencode-executor:status ${jobId}`);
  console.log(`Result: /opencode-executor:result ${jobId}`);
  console.log(`Cancel: /opencode-executor:cancel ${jobId}`);
}

// ---- status --------------------------------------------------------------
function eventSummary(e) {
  if (e?.type === 'text') return `text: ${e.part?.text || ''}`;
  if (e?.type === 'tool_use') return `tool_use: ${e.part?.tool || 'unknown'}`;
  if (e?.type === 'step_finish') return `step_finish: ${e.part?.reason || 'unknown'}`;
  if (e?.type === 'error') return `error: ${e.error?.data?.message || e.error?.message || 'unknown error'}`;
  return e?.type || 'unknown';
}

function tail(path, n) {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8').split('\n').slice(-n).join('\n');
}

function outputSummary(path, n = 20) {
  return readEvents(path).slice(-n).map(eventSummary).join('\n');
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
    console.log(`  status:    ${j.status}`);
    console.log(`  mode:      ${j.mode}`);
    console.log(`  pid:       ${j.pid ?? '-'}`);
    console.log(`  started:   ${j.startedAt}`);
    console.log(`  sessionID: ${j.sessionID ?? '-'}`);
    console.log(`  model:     ${j.model ?? '-'}`);
    console.log(`  task:      ${j.task}`);
    console.log(`  --- last output lines ---`);
    console.log(outputSummary(j.outputPath) || '(no output yet)');
    return;
  }
  if (state.jobs.length === 0) { console.log('No opencode jobs in this repository yet.'); return; }
  console.log('| job id | status | mode | started | task |');
  console.log('|---|---|---|---|---|');
  for (const j of state.jobs.slice(0, 15)) console.log(`| ${j.jobId} | ${j.status} | ${j.mode} | ${j.startedAt} | ${j.task} |`);
}

// ---- result --------------------------------------------------------------
function cmdResult(args) {
  const { dir } = baseDir();
  const state = refreshStatuses(loadState(dir));
  saveState(dir, state);
  const id = firstNonFlag(args);
  const j = id ? state.jobs.find((x) => x.jobId === id) : state.jobs[0];
  if (!j) { console.log(id ? `No job ${id}.` : 'No jobs yet.'); return; }
  if (args.includes('--raw')) {
    console.log(existsSync(j.outputPath) ? readFileSync(j.outputPath, 'utf8') : '');
    return;
  }
  if (!j.sessionID) j.sessionID = eventSessionId(readEvents(j.outputPath));
  saveState(dir, state);
  printResult(j);
}

function printResult(j) {
  const events = readEvents(j.outputPath);
  console.log(`Job ${j.jobId}`);
  console.log(`Status: ${j.status}`);
  console.log(`SessionID: ${j.sessionID ?? '-'}`);
  console.log(`Model: ${j.model ?? '-'}`);
  console.log('Tools used:');
  for (const e of events.filter((x) => x?.type === 'tool_use')) {
    const input = e.part?.state?.input || {};
    const target = input.filePath || input.command;
    console.log(`- ${e.part?.tool || 'unknown'} — ${e.part?.state?.status || 'unknown'}${target ? ` — ${target}` : ''}`);
  }
  console.log('Final answer:');
  console.log(events.filter((x) => x?.type === 'text').map((x) => x.part?.text || '').join(''));
  const error = events.find((x) => x?.type === 'error');
  if (j.error || error) console.log(`Error: ${j.error || error.error?.data?.message || error.error?.message || 'opencode reported an error'}`);
  const stderr = tail(j.stderrPath, 20).trim();
  if (stderr) { console.log('Stderr (last 20 lines):'); console.log(stderr); }
}

// ---- cancel --------------------------------------------------------------
function cmdCancel(args) {
  const { dir } = baseDir();
  const state = loadState(dir);
  const id = firstNonFlag(args) || (state.jobs.find((j) => j.status === 'running') || {}).jobId;
  const j = state.jobs.find((x) => x.jobId === id);
  if (!j) { console.log('No matching job to cancel.'); return; }
  if (!pidAlive(j.pid)) {
    if (j.status === 'running') {
      const result = deriveStatus(j, readEvents(j.outputPath));
      j.status = result.status;
      if (result.error) j.error = result.error;
    }
    saveState(dir, state);
    console.log(`Job ${j.jobId} is not running.`);
    return;
  }
  try { process.kill(-j.pid, 'SIGTERM'); } catch { try { process.kill(j.pid, 'SIGTERM'); } catch {} }
  j.status = 'cancelled';
  saveState(dir, state);
  console.log(`Cancelled job ${j.jobId} (pid ${j.pid}).`);
}

// ---- setup ---------------------------------------------------------------
function cmdSetup(args) {
  const json = args.includes('--json');
  const which = spawnSync('sh', ['-c', `command -v ${OPENCODE_BIN}`], { encoding: 'utf8' });
  const installed = which.status === 0 && which.stdout.trim().length > 0;
  let version = null;
  let models = [];
  if (installed) {
    const v = spawnSync(OPENCODE_BIN, ['--version'], { encoding: 'utf8' });
    version = (v.stdout || v.stderr || '').trim();
    const m = spawnSync(OPENCODE_BIN, ['models'], { encoding: 'utf8', maxBuffer: 1e7 });
    models = ((m.stdout || '') + '\n' + (m.stderr || '')).split('\n').map((x) => x.trim()).filter(Boolean);
  }
  if (json) {
    console.log(JSON.stringify({ opencodePath: installed ? which.stdout.trim() : null, installed, version, models }, null, 2));
    return;
  }
  console.log(`opencode installed: ${installed ? which.stdout.trim() : 'NO — install opencode'}`);
  if (installed) {
    console.log(`version: ${version || '-'}`);
    console.log(`models (${models.length}):`);
    for (const model of models) console.log(`- ${model}`);
  }
}

// ---- resume-candidate ----------------------------------------------------
function cmdResumeCandidate(args) {
  const { dir } = baseDir();
  const state = loadState(dir);
  const j = state.jobs.find((x) => x.sessionID);
  const report = { available: !!j, jobId: j ? j.jobId : null, sessionID: j ? j.sessionID : null };
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else console.log(report.available ? `Resumable: latest job ${report.jobId} (sessionID ${report.sessionID})` : 'No resumable opencode work in this repository.');
}

// ---- dispatch ------------------------------------------------------------
const [sub, ...rest] = process.argv.slice(2);
const table = {
  exec: cmdExec,
  status: cmdStatus,
  result: cmdResult,
  cancel: cmdCancel,
  setup: cmdSetup,
  'resume-candidate': cmdResumeCandidate,
};
if (!sub || !table[sub]) {
  console.log('Usage: opencode-runtime.mjs <exec|status|result|cancel|setup|resume-candidate> [args]');
  process.exit(sub ? 1 : 0);
}
table[sub](rest);
