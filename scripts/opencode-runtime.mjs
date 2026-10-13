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

function errorMessage(e) {
  return e?.error?.data?.message || e?.error?.message || 'opencode reported an error';
}

// opencode 2.x phát `error` cho cả lỗi provider tạm thời (504, stream đứt) rồi tự thử lại và chạy tiếp.
// Lỗi chỉ là chí mạng khi sau nó không còn tiến triển (text/tool_use/step_finish); step_start trơ trọi không tính.
const PROGRESS_TYPES = new Set(['text', 'tool_use', 'step_finish']);

function fatalError(events) {
  let idx = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === 'error') { idx = i; break; }
  if (idx === -1) return null;
  return events.slice(idx + 1).some((e) => PROGRESS_TYPES.has(e?.type)) ? null : events[idx];
}

// opencode 2.x có công cụ `question`; chạy không người trực thì câu hỏi không ai trả lời và run dừng ở đó.
function pendingQuestion(events) {
  const last = events.at(-1);
  return last?.type === 'tool_use' && last.part?.tool === 'question' ? last : null;
}

function deriveStatus(job, events, exitCode = null) {
  const fatal = fatalError(events);
  if (fatal) return { status: 'failed', error: errorMessage(fatal), errorType: fatal.error?.type || null };
  if (job.status === 'timeout') return { status: 'timeout', error: null };
  if (events.length === 0) return { status: 'empty', error: exitCode ? `opencode exited with code ${exitCode}` : null };
  if (pendingQuestion(events)) return { status: 'needs_input', error: null };
  const finishes = events.filter((e) => e?.type === 'step_finish');
  if (finishes.at(-1)?.part?.reason === 'stop') return { status: 'finished', error: null };
  if (exitCode !== null && exitCode !== 0) return { status: 'failed', error: `opencode exited with code ${exitCode}` };
  // opencode 2.x: bước cuối không phát step_finish 'stop' — tiến trình thoát 0 sau một khối text là xong.
  if ((exitCode === null || exitCode === 0) && events.at(-1)?.type === 'text') return { status: 'finished', error: null };
  return { status: 'incomplete', error: null };
}

function applyStatus(job, result) {
  job.status = result.status;
  job.error = result.error || undefined;
  job.errorType = result.errorType || undefined;
}

function readExitCode(job) {
  if (!job.exitCodePath || !existsSync(job.exitCodePath)) return null;
  const n = Number.parseInt(readFileSync(job.exitCodePath, 'utf8').trim(), 10);
  return Number.isNaN(n) ? null : n;
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
      j.exitCode = readExitCode(j);
      applyStatus(j, deriveStatus(j, events, j.exitCode));
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
  const exitCodePath = join(jobDir, 'exit_code');
  writeFileSync(promptPath, `${o.task}\n`);
  writeFileSync(outputPath, '');
  writeFileSync(stderrPath, '');
  const startedAt = new Date().toISOString();
  const timeoutAt = new Date(Date.now() + timeoutMs).toISOString();
  const taskLine = o.task.split('\n')[0].slice(0, 100);
  const opencodeArgs = buildOpencodeArgs(o, root, sessionId);
  const job = { jobId, pid: null, status: 'running', startedAt, timeoutAt, mode: o.background ? 'background' : 'wait', task: taskLine, model: o.model, sessionID: sessionId, outputPath, stderrPath, promptPath, exitCodePath };

  if (!o.background) {
    const res = spawnSync(OPENCODE_BIN, opencodeArgs, {
      cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 1e8,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    writeFileSync(outputPath, res.stdout || '');
    writeFileSync(stderrPath, res.stderr || '');
    const events = readEvents(outputPath);
    job.sessionID = eventSessionId(events) || sessionId;
    job.exitCode = res.status;
    if (res.error?.code === 'ETIMEDOUT') job.status = 'timeout';
    else applyStatus(job, deriveStatus(job, events, res.status));
    if (res.error && res.error.code !== 'ETIMEDOUT') job.error = res.error.message;
    state.jobs.unshift(job);
    saveState(dir, state);
    printResult(job);
    console.log(`\nJob ${jobId} — ${job.status}. Result: /opencode-executor:result ${jobId}`);
    if (job.status !== 'finished') { console.log('This run was not a success.'); process.exitCode = 1; }
    return;
  }

  const outFd = openSync(outputPath, 'a');
  const errFd = openSync(stderrPath, 'a');
  // Bọc bằng sh để ghi mã thoát của opencode ra file — tiến trình nền đã tách nên không lấy được qua spawn.
  // sh là trưởng nhóm tiến trình, nên kill(-pid) khi timeout/cancel vẫn dừng cả opencode.
  const wrapper = '"$0" "$@"; echo $? > "$OPENCODE_EXECUTOR_EXIT_FILE"';
  const child = spawn('/bin/sh', ['-c', wrapper, OPENCODE_BIN, ...opencodeArgs], {
    cwd: root, detached: true, stdio: ['ignore', outFd, errFd],
    env: { ...process.env, OPENCODE_EXECUTOR_EXIT_FILE: exitCodePath },
  });
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
  if (e?.type === 'error') return `error${e.error?.type ? ` (${e.error.type})` : ''}: ${errorMessage(e)}`;
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
    // opencode 2.x ghi đường dẫn ở `path`; 1.x dùng `filePath`.
    const target = input.filePath || input.path || input.command || input.pattern;
    console.log(`- ${e.part?.tool || 'unknown'} — ${e.part?.state?.status || 'unknown'}${target ? ` — ${target}` : ''}`);
  }
  console.log('Final answer:');
  console.log(events.filter((x) => x?.type === 'text').map((x) => x.part?.text || '').join(''));
  const question = pendingQuestion(events);
  if (question) {
    console.log('Pending question (opencode stopped to ask; answer by resuming the session with --resume):');
    for (const q of question.part?.state?.input?.questions || []) {
      console.log(`- ${q.header || ''}${q.question ? `: ${q.question}` : ''}`);
      for (const opt of q.options || []) console.log(`  * ${opt.label}${opt.description ? ` — ${opt.description}` : ''}`);
    }
  }
  const errors = events.filter((x) => x?.type === 'error');
  if (j.error) console.log(`Error: ${j.error}${j.errorType ? ` (${j.errorType})` : ''}`);
  if (j.errorType === 'provider.quota') console.log('The provider is rate-limiting or out of quota — wait, then continue with --resume.');
  const recovered = errors.length - (fatalError(events) ? 1 : 0);
  if (recovered > 0) console.log(`Recovered from ${recovered} transient provider error(s) during the run.`);
  if (j.exitCode !== undefined && j.exitCode !== null) console.log(`Exit code: ${j.exitCode}`);
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
      j.exitCode = readExitCode(j);
      applyStatus(j, deriveStatus(j, readEvents(j.outputPath), j.exitCode));
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
// opencode 2.x: `models` hỏi server nền; server vừa khởi động chưa nạp xong danh mục provider
// nên trả rỗng (exit 0, không báo lỗi) trong ~1s đầu. Thử lại đến khi có model.
// Không dùng --standalone: server riêng mỗi lần gọi luôn lạnh nên luôn rỗng.
function listModels() {
  const attempts = 12;
  for (let i = 0; i < attempts; i++) {
    const m = spawnSync(OPENCODE_BIN, ['models'], {
      encoding: 'utf8', maxBuffer: 1e7, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const models = ((m.stdout || '') + '\n' + (m.stderr || '')).split('\n')
      .map((x) => x.trim()).filter((x) => /^[\w.-]+\/\S+$/.test(x));
    if (models.length > 0) return models;
    if (i < attempts - 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  return [];
}

function cmdSetup(args) {
  const json = args.includes('--json');
  const which = spawnSync('sh', ['-c', `command -v ${OPENCODE_BIN}`], { encoding: 'utf8' });
  const installed = which.status === 0 && which.stdout.trim().length > 0;
  let version = null;
  let models = [];
  if (installed) {
    const v = spawnSync(OPENCODE_BIN, ['--version'], { encoding: 'utf8' });
    version = (v.stdout || v.stderr || '').trim();
    models = listModels();
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
    if (models.length === 0) console.log('No models listed — check `opencode auth list` and `opencode service status`.');
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
