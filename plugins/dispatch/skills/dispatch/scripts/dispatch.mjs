#!/usr/bin/env node
// dispatch.mjs — the /dispatch CLI. Node stdlib only, zero deps.
// The SAME file runs on both sides: the sender uses the top-level commands
// (they own the ssh calls and resolve everything from the ledger by id); the
// worker uses `worker <sub>` from inside its dispatch dir. Both canonicalize +
// HMAC identically because they are the same code.
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const configDir = join(homedir(), '.config', 'dispatch')
const configPath = join(configDir, 'config.json')
const ledgerPath = join(configDir, 'history.jsonl')
const defaultModeState = join(configDir, 'mode.json')

const excludedNames = new Set(['.git', 'node_modules', 'dist', 'build', '.DS_Store'])
const sensitiveAllowlist = new Set(['.env.example', '.env.sample', '.env.template'])
const POINTER = (file) => `Read the file ${file} in this directory and follow it exactly. Begin now.`
const SIGNED_OUT = /log ?in|not logged in|unauthori[sz]ed|\b401\b|invalid api key|device code|authenticate/i
const LOGIN_FIX = { claude: 'claude /login', codex: 'codex login', opencode: 'opencode auth login', gemini: 'gemini (then /auth)' }
const AUTH_PROBE = {
  claude: 'claude -p "reply with exactly OK"',
  codex: 'cd /tmp && codex exec --skip-git-repo-check "reply with exactly OK"',
  opencode: 'opencode run "reply with exactly OK"',
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'worker') return workerMain(rest)
  const positional = rest[0] && !rest[0].startsWith('--') ? rest.shift() : null
  const options = parseOptions(rest)
  const id = () => positional ?? requiredOption(options, 'id')

  switch (command) {
    // primitives (also used remotely)
    case 'keygen': return printJson(keygen())
    case 'manifest': return printJson(manifest(options))
    case 'sign': return printJson(sign(options))
    case 'verify': return exitJson(verify(options))
    case 'check-heartbeat': return exitJson(checkHeartbeat(options))
    case 'verify-result': return exitJson(verifyResult(options))
    // fleet mode
    case 'mode': return printJson(readMode(options.get('state')))
    case 'set-mode': return printJson(setMode(options))
    case 'reminder-check': return reminderCheck(options)
    // worker registry probes
    case 'discover': return printJson(discover(positional ?? options.get('worker')))
    case 'check': return exitJson(check(positional ?? options.get('worker')))
    // the send flow, by id
    case 'prepare': return printJson(prepare(options))
    case 'transfer': return exitJson(transfer(id(), options))
    case 'launch': return printJson(launch(id(), options))
    case 'await-ack': return exitJson(awaitAck(id(), options))
    case 'status': return exitJson(status(id(), options))
    case 'follow': return follow(id(), options)
    case 'pane': return process.stdout.write(pane(ledgerFor(id()), Number(options.get('lines') ?? 200)))
    case 'steer': return printJson(steer(id(), options))
    case 'collect': return exitJson(collect(id(), options))
    case 'recall': return printJson(recall(id(), options))
    case 'mark': return printJson(mark(id(), requiredOption(options, 'status'), {}))
    case 'sessions': return printJson(sessions())
    case 'history': return printJson(history())
    default: usage()
  }
}

// --- primitives -----------------------------------------------------------

function keygen() {
  return {
    dispatchId: `dsp-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`,
    key: randomBytes(32).toString('hex'),
    algo: 'HMAC-SHA256',
  }
}

// manifest — content-addressed fingerprint of the curated context set.
function manifest(options) {
  const root = resolve(requiredOption(options, 'root'))
  const pathsFile = options.get('paths-file')
  const { candidates, skippedSymlinks, excludedSensitive } = pathsFile ? explicitList(root, pathsFile) : collectFiles(root)
  const files = candidates.map((path) => {
    const data = readFileSync(join(root, path))
    return { path, size: data.byteLength, sha256: hash(data) }
  })
  const manifestValue = { version: 1, mode: 'context', files }
  const manifestHash = hash(Buffer.from(canonicalJson(manifestValue)))
  const result = { manifestHash, fileCount: files.length, skippedSymlinks, excludedSensitive, paths: candidates }
  if (options.get('out')) {
    writeJsonFile(options.get('out'), { ...manifestValue, manifestHash })
    result.written = resolve(options.get('out'))
  }
  return result
}

function signObject(key, body) {
  const clean = { ...body }
  delete clean.hmac
  return { ...clean, hmac: hmac(key, canonicalJson(clean)) }
}

function verifyObject(key, message) {
  const body = { ...message }
  delete body.hmac
  return typeof message.hmac === 'string' && safeEqualHex(message.hmac, hmac(key, canonicalJson(body)))
}

function sign(options) {
  const key = requiredOption(options, 'key')
  const signed = signObject(key, readJsonFile(requiredOption(options, 'in')))
  if (options.get('out')) writeJsonFile(options.get('out'), signed)
  else printJson(signed)
  return { signed: true }
}

function verify(options) {
  const message = readJsonFile(requiredOption(options, 'in'))
  const verified = verifyObject(requiredOption(options, 'key'), message)
  return { result: { verified, dispatchId: message.dispatchId ?? null, type: message.type ?? null }, ok: verified }
}

// check-heartbeat — verify signature, then judge liveness from updatedAt (the
// pulse) and progressAt (the agent's last real report) against the deadline.
function checkHeartbeat(options) {
  const { result: v, ok } = verify(options)
  if (!ok) return { result: { ...v, verdict: 'unverified' }, ok: false }
  return judge(readJsonFile(options.get('in')), Number(options.get('max-stale-seconds') ?? 900), options.get('deadline'))
}

function judge(hb, maxStale, deadlineIso) {
  const now = Date.now()
  const age = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? Math.round((now - t) / 1000) : null }
  const ageSeconds = age(hb.updatedAt)
  const progressAgeSeconds = age(hb.progressAt ?? hb.updatedAt)
  const deadline = deadlineIso ? Date.parse(deadlineIso) : null
  let verdict
  if (hb.status === 'done' || hb.status === 'failed' || hb.status === 'blocked') verdict = hb.status
  else if (deadline && now > deadline) verdict = 'expired'
  else if (ageSeconds !== null && ageSeconds > maxStale) verdict = 'dark'
  else if (progressAgeSeconds !== null && progressAgeSeconds > maxStale) verdict = 'idle'
  else verdict = 'alive'
  return {
    result: { verified: true, status: hb.status ?? null, verdict, ageSeconds, progressAgeSeconds, maxStale, progress: hb.progress ?? null, summary: hb.summary ?? null },
    ok: ['done', 'alive', 'idle'].includes(verdict),
  }
}

// verify-result — signature valid AND the returned tree/bundle re-hashes to
// what the worker signed.
function verifyResult(options) {
  const key = requiredOption(options, 'key')
  const resultPath = requiredOption(options, 'result')
  const { result: v, ok } = verify(new Map([['key', key], ['in', resultPath]]))
  if (!ok) return { result: { ...v, verdict: 'unverified-signature' }, ok: false }
  const result = readJsonFile(resultPath)
  const claimed = result.manifestHash ?? null
  let recomputed = null
  if (options.get('bundle')) recomputed = hash(readFileSync(options.get('bundle')))
  else if (options.get('root')) recomputed = manifest(new Map([['root', options.get('root')]])).manifestHash
  else return { result: { verified: true, manifestMatch: null, claimed, status: result.status }, ok: true }
  const manifestMatch = typeof claimed === 'string' && recomputed === claimed
  return { result: { verified: true, manifestMatch, claimed, recomputed, status: result.status }, ok: manifestMatch }
}

// --- worker registry ------------------------------------------------------

function readConfig() {
  return existsSync(configPath) ? readJsonFile(configPath) : { defaultWorker: null, workers: {} }
}

function workerEntry(name) {
  const config = readConfig()
  const key = name ?? config.defaultWorker
  const worker = key && config.workers?.[key]
  if (!worker) throw new Error(`No worker "${key ?? '(default)'}" in ${configPath} — run /dispatch add`)
  return { name: key, ...worker }
}

function discover(name) {
  const w = workerEntry(name)
  const r = ssh(w.ssh, 'bash -lc "for c in claude opencode codex gemini hermes aider goose amp openclaw; do command -v \\"\\$c\\" >/dev/null 2>&1 && echo \\"\\$c\\"; done; true"')
  return { worker: w.name, ssh: w.ssh, found: r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) }
}

// check — reachable, node>=20, tmux, agent binary, and the mandatory auth
// probe (a signed-out CLI is the top dispatch killer; catch it in ~20s here).
function check(name) {
  const w = workerEntry(name)
  const bin = (w.agentCommand ?? '').split(/\s+/)[0]
  const probe = ssh(w.ssh, `bash -lc 'echo NODE=$(node --version 2>/dev/null); echo TMUX=$(tmux -V 2>/dev/null); echo AGENT=$(command -v ${bin} 2>/dev/null)'`, { allowFail: true, timeout: 30000 })
  const out = probe.stdout ?? ''
  const nodeVersion = out.match(/NODE=v?([\d.]+)/)?.[1] ?? null
  const result = {
    worker: w.name, ssh: w.ssh, agentCommand: w.agentCommand ?? null,
    reachable: probe.status === 0,
    node: nodeVersion, nodeOk: Number(nodeVersion?.split('.')[0]) >= 20,
    tmux: /TMUX=tmux/.test(out),
    agentFound: /AGENT=\S+/.test(out),
    auth: null, fix: null,
  }
  if (result.reachable && result.agentFound) {
    const cmd = AUTH_PROBE[bin] ?? `${bin} "reply with exactly OK"`
    const a = ssh(w.ssh, `bash -lc '${cmd}'`, { allowFail: true, timeout: 75000 })
    const text = `${a.stdout ?? ''}\n${a.stderr ?? ''}`
    const authed = a.status === 0 && !SIGNED_OUT.test(text)
    result.auth = authed ? 'ok' : a.error?.code === 'ETIMEDOUT' ? 'timeout' : 'signed-out'
    result.authOutput = text.trim().slice(-400)
    if (!authed) result.fix = `ssh -t ${w.ssh} '${LOGIN_FIX[bin] ?? `${bin} <its login command>`}'`
    if (authed) {
      const config = readConfig()
      config.workers[w.name].lastAuthOkAt = new Date().toISOString()
      writeJsonFile(configPath, config)
    }
  }
  const ok = result.reachable && result.nodeOk && result.tmux && result.agentFound && result.auth === 'ok'
  return { result: { ...result, ready: ok }, ok }
}

// --- send flow ------------------------------------------------------------

// prepare — keygen + manifest + envelope + sign + ledger in one call. Worker
// defaults come from config (--worker); explicit flags override.
function prepare(options) {
  const w = options.get('worker') ? workerEntry(options.get('worker')) : {}
  const outDir = resolve(requiredOption(options, 'out-dir'))
  const root = resolve(requiredOption(options, 'root'))
  const prompt = readFileSync(requiredOption(options, 'prompt-file'), 'utf8')
  const gate = requiredOption(options, 'gate')
  const ssh = options.get('ssh') ?? w.ssh
  if (!ssh) throw new Error('Missing --ssh (or --worker <name> with ssh in config)')
  const dispatchDir = options.get('dispatch-dir') ?? w.dispatchDir ?? '~/dispatch-inbox'
  const method = options.get('return-method') ?? (options.get('ref') ? 'git-branch' : 'ssh-pull')
  const heartbeatSeconds = Number(options.get('heartbeat-seconds') ?? w.heartbeatSeconds ?? 300)
  const maxStaleSeconds = Number(options.get('max-stale-seconds') ?? w.maxStaleSeconds ?? 900)
  const deadlineMinutes = Number(options.get('deadline-minutes') ?? w.deadlineMinutes ?? 60)
  const constraints = (options.get('constraints') ?? '').split(';').map((c) => c.trim()).filter(Boolean)

  const { dispatchId, key } = keygen()
  const remoteDir = `${dispatchDir}/${dispatchId}`
  const manifestOptions = new Map([['root', root], ['out', join(outDir, 'context.manifest.json')]])
  if (options.get('paths-file')) manifestOptions.set('paths-file', options.get('paths-file'))
  const contextInfo = manifest(manifestOptions)
  writeFileSync(join(outDir, 'context.paths'), `${contextInfo.paths.join('\n')}\n`)

  const body = {
    dispatchId, type: 'dispatch', protocol: 'dep/1',
    sender: options.get('sender') ?? 'dispatch-sender',
    return: { method, dir: `${remoteDir}/return`, ...(options.get('ref') ? { ref: options.get('ref') } : {}) },
    context: { manifestHash: contextInfo.manifestHash, root: `${remoteDir}/context` },
    prompt, constraints, gate, heartbeatSeconds,
    deadline: new Date(Date.now() + deadlineMinutes * 60000).toISOString(),
  }
  writeJsonFile(join(outDir, 'envelope.json'), signObject(key, body))
  appendLedger({
    at: new Date().toISOString(), dispatchId, worker: w.name ?? options.get('worker') ?? null, ssh, mode: method,
    ref: options.get('ref') ?? null, remoteDir, localOutDir: outDir, contextRoot: root,
    contextManifest: contextInfo.manifestHash, key, tmuxSession: dispatchId, heartbeatSeconds, maxStaleSeconds,
    deadline: body.deadline, status: 'prepared', gate,
  })
  const { paths, ...contextSummary } = contextInfo
  return {
    dispatchId, remoteDir, envelope: join(outDir, 'envelope.json'), manifest: contextSummary, deadline: body.deadline,
    next: `node dispatch.mjs transfer ${dispatchId} [--bundle <f> | --branch <ref> --repo-url <url> | (files: nothing extra)]`,
  }
}

// transfer — create the remote dir, ship script + envelope + key, place the
// context (files tarball | git bundle | clone of pushed branch), then have the
// worker recompute the manifest. Mismatch = do not launch.
function transfer(id, options) {
  const L = ledgerFor(id)
  const home = ssh(L.ssh, 'echo $HOME').stdout.trim()
  const remoteDir = L.remoteDir.replace(/^~(?=\/|$)/, home)
  ssh(L.ssh, `mkdir -p '${remoteDir}/context' '${remoteDir}/return'`)
  scp(L.ssh, [resolve(process.argv[1]), join(L.localOutDir, 'envelope.json')], `${remoteDir}/`)
  ssh(L.ssh, `umask 077 && cat > '${remoteDir}/key'`, { input: L.key })

  let placed
  if (options.get('bundle')) {
    scp(L.ssh, [options.get('bundle')], `${remoteDir}/ctx.bundle`)
    ssh(L.ssh, `git clone -q '${remoteDir}/ctx.bundle' '${remoteDir}/context'${L.ref ? ` && git -C '${remoteDir}/context' checkout -q '${L.ref}'` : ''}`)
    placed = 'bundle'
  } else if (options.get('branch')) {
    ssh(L.ssh, `git clone -q -b '${options.get('branch')}' '${requiredOption(options, 'repo-url')}' '${remoteDir}/context'`)
    placed = 'branch'
  } else {
    const tar = spawnSync('tar', ['-C', L.contextRoot, '-cf', '-', '-T', join(L.localOutDir, 'context.paths')], { maxBuffer: 1 << 30 })
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`)
    ssh(L.ssh, `tar -C '${remoteDir}/context' -xf -`, { input: tar.stdout })
    placed = 'files'
  }
  const remote = JSON.parse(ssh(L.ssh, `cd '${remoteDir}' && node dispatch.mjs manifest --root context`).stdout)
  const manifestMatch = remote.manifestHash === L.contextManifest
  mark(id, manifestMatch ? 'transferred' : 'transfer-mismatch', { remoteDir, placed })
  return {
    result: { dispatchId: id, remoteDir, placed, manifestMatch, expected: L.contextManifest, remote: remote.manifestHash, remoteFileCount: remote.fileCount,
      next: manifestMatch ? `node dispatch.mjs launch ${id} --agent "<agentCommand>" [--mode interactive|headless]` : 'context did not arrive intact — fix and re-run transfer; do NOT launch' },
    ok: manifestMatch,
  }
}

// launch — start the agent in tmux (window "agent") + the heartbeat pulse
// (window "pulse"), then hand the agent the receiver prompt via file+pointer.
function launch(id, options) {
  const L = ledgerFor(id)
  const agent = options.get('agent') ?? workerEntry(L.worker).agentCommand
  if (!agent) throw new Error('Missing --agent')
  const mode = options.get('mode') ?? 'interactive'
  const D = L.remoteDir
  writeRemote(L.ssh, `${D}/receiver.md`, receiverPrompt(L))
  const run = mode === 'headless'
    ? `#!/bin/bash -l\ncd '${D}'\n${agent} < receiver.md > agent.log 2>&1\necho "[dispatch] agent exited with status $?" >> agent.log\n`
    : `#!/bin/bash -l\ncd '${D}'\nexec ${agent}\n`
  writeRemote(L.ssh, `${D}/run.sh`, run, '755')
  // remain-on-exit keeps a dead agent's last screen capturable for triage.
  ssh(L.ssh, `tmux new-session -d -s '${id}' -n agent -c '${D}' '${D}/run.sh' && tmux set-option -t '${id}:agent' remain-on-exit on`)
  if (options.get('pulse') !== 'false') ssh(L.ssh, `tmux new-window -d -t '${id}' -n pulse -c '${D}' 'node dispatch.mjs worker pulse'`)
  let pointerSent = false
  const dismissed = []
  if (mode !== 'headless') {
    sleep(Number(options.get('settle-seconds') ?? 10) * 1000)
    // Known startup interstitials that would swallow the pointer (codex
    // self-update menu: Enter = "Update now", which then exits the agent).
    for (let i = 0; i < 3; i++) {
      const screen = pane(L, 30)
      if (/Update available/i.test(screen) && /Skip/.test(screen)) { ssh(L.ssh, `tmux send-keys -t '${id}:agent' 2 Enter`); dismissed.push('codex-update-prompt'); sleep(4000); continue }
      // Trust-this-directory dialogs (codex, claude): the dir holds only our own files → accept the default Yes.
      if (/trust/i.test(screen) && /Yes/.test(screen)) { ssh(L.ssh, `tmux send-keys -t '${id}:agent' Enter`); dismissed.push('trust-directory-prompt'); sleep(4000); continue }
      break
    }
    ssh(L.ssh, `tmux send-keys -t '${id}:agent' -l '${POINTER('receiver.md')}' && sleep 1 && tmux send-keys -t '${id}:agent' Enter`)
    pointerSent = true
  }
  mark(id, 'launched', { agent, runMode: mode, launchedAt: new Date().toISOString() })
  return { dispatchId: id, mode, agent, pointerSent, dismissed, attach: `ssh -t ${L.ssh} 'tmux attach -t ${id}'`, pane: pane(L, 30), next: `node dispatch.mjs await-ack ${id}` }
}

function receiverPrompt(L) {
  return [
    `You are a dispatch worker. Your working directory is ${L.remoteDir}. Everything you need is here; the task itself is inside envelope.json and will be printed by step 1.`,
    '',
    'Run these commands (with your shell tool), in order:',
    '1. node dispatch.mjs worker init',
    '   Verifies the task is authentic and the context arrived intact, then prints the task, constraints, and gate. If it prints "refuse", stop and do nothing else.',
    '2. node dispatch.mjs worker ack --understanding "<one paragraph: what you will do>" --plan "<numbered steps>" --will-not-do "<what is out of scope>"',
    '3. Do the task. Context is in ./context. Stay within the constraints; the gate is the definition of done.',
    `   Returned work: ${L.mode === 'git-branch' ? `commit on branch ${L.ref} inside ./context, then run: git -C context bundle create return/work.bundle ${L.ref}` : 'put deliverable files under ./return/work/'}`,
    '   Report progress at each milestone: node dispatch.mjs worker heartbeat --status working --progress "<one line>"',
    '   If you are stuck on something the constraints do not cover: node dispatch.mjs worker heartbeat --status blocked --progress "<the question>" — then wait; an answer arrives as a steer file.',
    '4. Finish with: node dispatch.mjs worker done --summary "<what you did, how you verified the gate>"',
    '   or, if you could not complete it: node dispatch.mjs worker failed --summary "<what happened, what partial work exists>". Never fabricate success.',
    '',
    'Files named steer-N.md may appear in this directory later; when told to read one, follow it, then run worker heartbeat/done again so the sender sees the update.',
    '',
  ].join('\n')
}

// await-ack — timeboxed handshake. The signed ack proves the worker holds the
// key and confirmed the context. No ack in time → pane capture for triage.
function awaitAck(id, options) {
  const L = ledgerFor(id)
  const timeout = Number(options.get('timeout-seconds') ?? 120)
  const start = Date.now()
  while (true) {
    const r = ssh(L.ssh, `cat '${L.remoteDir}/return/ack.json' 2>/dev/null`, { allowFail: true })
    if (r.status === 0 && r.stdout.trim()) {
      const ack = JSON.parse(r.stdout)
      const verified = verifyObject(L.key, ack) && ack.dispatchId === id && ack.contextManifestVerified === true
      mark(id, verified ? 'dispatched' : 'ack-unverified', {})
      return { result: { dispatchId: id, ack: verified ? 'verified' : 'INVALID', understanding: ack.understanding, plan: ack.plan, willNotDo: ack.willNotDo, gate: ack.gate, agent: ack.agent,
        next: verified ? `node dispatch.mjs follow ${id}` : 'stop — unverified ack is not a started dispatch' }, ok: verified }
    }
    if (Date.now() - start > timeout * 1000) {
      return { result: { dispatchId: id, ack: 'none', elapsedSeconds: Math.round((Date.now() - start) / 1000), pane: pane(L, 60),
        next: 'launch triage: read the pane; signed-out → escalate the fix command; codex update prompt → node dispatch.mjs steer --keys "2 Enter"; agent working but no ack → steer a pointer to receiver.md' }, ok: false }
    }
    sleep(Number(options.get('poll-seconds') ?? 20) * 1000)
  }
}

// status — pull the latest signed signal and judge it; includes the pane on
// anything that is not plainly alive so triage is a single call.
function status(id, options) {
  const L = ledgerFor(id)
  const r = ssh(L.ssh, `cat '${L.remoteDir}/return/result.json' 2>/dev/null || cat '${L.remoteDir}/return/heartbeat.json' 2>/dev/null || echo NOSIGNAL`)
  const alive = ssh(L.ssh, `tmux has-session -t '${id}' 2>/dev/null && echo yes || echo no`).stdout.trim() === 'yes'
  let out
  if (r.stdout.trim() === 'NOSIGNAL') {
    const since = L.launchedAt ? Math.round((Date.now() - Date.parse(L.launchedAt)) / 1000) : null
    const verdict = since !== null && since > L.maxStaleSeconds ? 'dark' : 'no-signal'
    out = { result: { verified: null, status: null, verdict, sinceLaunchSeconds: since }, ok: verdict === 'no-signal' }
  } else {
    const sig = JSON.parse(r.stdout)
    out = verifyObject(L.key, sig) && sig.dispatchId === id
      ? judge(sig, L.maxStaleSeconds, L.deadline)
      : { result: { verified: false, verdict: 'unverified' }, ok: false }
  }
  out.result = { dispatchId: id, ...out.result, sessionAlive: alive }
  if (!['alive', 'done'].includes(out.result.verdict) || options.get('pane') === 'true') out.result.pane = pane(L, Number(options.get('lines') ?? 40))
  if (['done', 'failed'].includes(out.result.verdict)) out.result.next = `node dispatch.mjs collect ${id} --into <fresh-empty-dir>`
  return out
}

// follow — poll status on the heartbeat interval; one JSON line per poll; exits
// on the first verdict that needs the orchestrator (done/failed/blocked/dark/
// expired/unverified). Run it in the background and read its output.
function follow(id, options) {
  const L = ledgerFor(id)
  const interval = Number(options.get('interval-seconds') ?? L.heartbeatSeconds ?? 300)
  while (true) {
    const s = status(id, new Map())
    printJson({ at: new Date().toISOString(), ...s.result })
    if (!['alive', 'idle', 'no-signal'].includes(s.result.verdict)) { process.exitCode = s.ok ? 0 : 1; return }
    sleep(interval * 1000)
  }
}

// pane — the agent window's screen; headless runs have no screen, so fall
// back to the tail of agent.log.
function pane(L, lines) {
  const r = ssh(L.ssh, `tmux capture-pane -pt '${L.dispatchId}:agent' -S -${lines} 2>/dev/null || tmux capture-pane -pt '${L.dispatchId}' -S -${lines} 2>/dev/null || echo '[no tmux session ${L.dispatchId}]'`, { allowFail: true })
  const screen = (r.stdout ?? '').replace(/\n+$/, '\n')
  if (screen.trim() && !screen.startsWith('[no tmux')) return screen
  const log = ssh(L.ssh, `tail -n ${lines} '${L.remoteDir}/agent.log' 2>/dev/null`, { allowFail: true }).stdout ?? ''
  return log.trim() ? `[agent.log tail]\n${log}` : screen
}

// steer — file+pointer injection into a running interactive agent (raw text
// through send-keys breaks on quotes). --keys sends literal tmux keys instead
// (e.g. "2 Enter" to skip a codex self-update prompt, "C-c" to interrupt).
function steer(id, options) {
  const L = ledgerFor(id)
  if (options.get('keys')) {
    ssh(L.ssh, `tmux send-keys -t '${id}:agent' ${options.get('keys')}`)
    sleep(2000)
    return { dispatchId: id, sentKeys: options.get('keys'), pane: pane(L, 20) }
  }
  const file = requiredOption(options, 'file')
  const n = Number(ssh(L.ssh, `ls '${L.remoteDir}'/steer-*.md 2>/dev/null | wc -l`).stdout.trim()) + 1
  const name = `steer-${n}.md`
  writeRemote(L.ssh, `${L.remoteDir}/${name}`, readFileSync(file, 'utf8'))
  ssh(L.ssh, `tmux send-keys -t '${id}:agent' -l '${POINTER(name)}' && sleep 1 && tmux send-keys -t '${id}:agent' Enter`)
  sleep(3000)
  mark(id, 'steered', { steer: name })
  return { dispatchId: id, sent: name, pane: pane(L, 20) }
}

// collect — pull the returned work into a FRESH dir, verify signature +
// integrity, and hand back the gate to run. Integration stays with you.
function collect(id, options) {
  const L = ledgerFor(id)
  const into = resolve(requiredOption(options, 'into'))
  if (existsSync(into) && readdirSync(into).length) throw new Error(`--into must be a fresh/empty directory: ${into}`)
  mkdirSync(into, { recursive: true })
  const localResult = join(L.localOutDir, 'result.json')
  writeFileSync(localResult, ssh(L.ssh, `cat '${L.remoteDir}/return/result.json'`).stdout)
  const kind = ssh(L.ssh, `test -f '${L.remoteDir}/return/work.bundle' && echo bundle || (test -d '${L.remoteDir}/return/work' && echo files || echo none)`).stdout.trim()
  const vopts = new Map([['key', L.key], ['result', localResult]])
  let where = null
  if (kind === 'bundle') {
    const bundle = join(L.localOutDir, 'work.bundle')
    scpFrom(L.ssh, `${L.remoteDir}/return/work.bundle`, bundle)
    vopts.set('bundle', bundle)
    const clone = spawnSync('git', ['clone', '-q', ...(L.ref ? ['-b', L.ref] : []), bundle, into], { encoding: 'utf8' })
    if (clone.status !== 0) throw new Error(`git clone of bundle failed: ${clone.stderr}`)
    where = into
  } else if (kind === 'files') {
    scpFrom(L.ssh, `${L.remoteDir}/return/work/.`, into, true)
    vopts.set('root', into)
    where = into
  }
  const v = verifyResult(vopts)
  const result = readJsonFile(localResult)
  mark(id, v.ok ? 'verified' : 'verify-failed', { collectedInto: where })
  return {
    result: { dispatchId: id, ...v.result, work: kind, into: where, summary: result.summary ?? null, notes: result.notes ?? null, gate: L.gate,
      next: v.ok ? `run the gate ("${L.gate}") against ${where ?? 'the returned branch'}; only if it passes, review the diff and integrate; then: node dispatch.mjs mark ${id} --status collected` : 'do NOT integrate — signature or manifest failed' },
    ok: v.ok,
  }
}

// recall — interrupt, kill every tmux session the dispatch owns, and (with
// --purge) remove ONLY the verified dispatch dir.
function recall(id, options) {
  const L = ledgerFor(id)
  ssh(L.ssh, `tmux send-keys -t '${id}:agent' C-c 2>/dev/null; for s in '${id}' '${id}-web' '${id}-tun'; do tmux kill-session -t "$s" 2>/dev/null; done; true`)
  let purged = false
  if (options.get('purge') === 'true') {
    if (!/\/dsp-[\w-]+$/.test(L.remoteDir) || L.remoteDir.includes('..')) throw new Error(`refusing to purge suspicious dir ${L.remoteDir}`)
    ssh(L.ssh, `rm -rf '${L.remoteDir}'`)
    purged = true
  }
  mark(id, 'recalled', { purged })
  return { dispatchId: id, killed: [id, `${id}-web`, `${id}-tun`], purged, remoteDir: L.remoteDir }
}

function sessions() {
  const config = readConfig()
  const ledger = history()
  return Object.entries(config.workers ?? {}).map(([name, w]) => {
    const r = ssh(w.ssh, `tmux ls -F '#{session_name}' 2>/dev/null; true`, { allowFail: true })
    const names = (r.stdout ?? '').split('\n').filter((s) => s.startsWith('dsp-'))
    return { worker: name, ssh: w.ssh, reachable: r.status === 0, sessions: names.map((s) => {
      const id = s.replace(/-(web|tun)$/, '')
      const rec = ledger.find((l) => l.dispatchId === id)
      return { session: s, role: s.endsWith('-web') ? 'web' : s.endsWith('-tun') ? 'tunnel' : 'agent', dispatchId: id, ledgerStatus: rec?.status ?? 'unknown', deadline: rec?.deadline ?? null }
    }) }
  })
}

// --- worker side ----------------------------------------------------------
// Runs inside <remoteDir>: reads ./key + ./envelope.json, writes ./return/*.

function workerMain(argv) {
  const [sub, ...rest] = argv
  const options = parseOptions(rest)
  const dir = resolve(options.get('dir') ?? '.')
  const key = readFileSync(join(dir, 'key'), 'utf8').trim()
  const env = readJsonFile(join(dir, 'envelope.json'))
  const returnDir = join(dir, 'return')
  const write = (name, body) => writeJsonFile(join(returnDir, name), signObject(key, { dispatchId: env.dispatchId, ...body }))
  const heartbeat = (status, progress, progressAt) => write('heartbeat.json', { type: 'heartbeat', status, updatedAt: new Date().toISOString(), progressAt: progressAt ?? new Date().toISOString(), progress })

  switch (sub) {
    case 'init': {
      if (!verifyObject(key, env)) return printJson({ verdict: 'refuse', reason: 'envelope signature invalid — task is not authentic' })
      const m = manifest(new Map([['root', join(dir, 'context')]]))
      if (m.manifestHash !== env.context.manifestHash) return printJson({ verdict: 'refuse', reason: 'context manifest mismatch', expected: env.context.manifestHash, actual: m.manifestHash })
      heartbeat('working', 'initialized')
      return printJson({ verdict: 'ok', dispatchId: env.dispatchId, prompt: env.prompt, constraints: env.constraints, gate: env.gate, return: env.return, heartbeatSeconds: env.heartbeatSeconds, deadline: env.deadline, contextFiles: m.fileCount })
    }
    case 'ack':
      write('ack.json', { type: 'ack', agent: options.get('agent') ?? process.env.DISPATCH_AGENT ?? 'unknown', workspace: dir, contextManifestVerified: manifest(new Map([['root', join(dir, 'context')]])).manifestHash === env.context.manifestHash,
        understanding: requiredOption(options, 'understanding'), plan: requiredOption(options, 'plan'), willNotDo: options.get('will-not-do') ?? '', gate: env.gate })
      return printJson({ written: 'return/ack.json' })
    case 'heartbeat':
      heartbeat(options.get('status') ?? 'working', options.get('progress') ?? '')
      return printJson({ written: 'return/heartbeat.json', status: options.get('status') ?? 'working' })
    case 'done':
    case 'failed': {
      const bundle = join(returnDir, 'work.bundle')
      const work = join(returnDir, 'work')
      const manifestHash = existsSync(bundle) ? hash(readFileSync(bundle)) : existsSync(work) ? manifest(new Map([['root', work]])).manifestHash : null
      write('result.json', { type: 'result', status: sub, summary: requiredOption(options, 'summary'), notes: options.get('notes') ?? '', manifestHash, ref: env.return?.ref ?? null, updatedAt: new Date().toISOString() })
      heartbeat(sub, options.get('summary'))
      return printJson({ written: 'return/result.json', status: sub, manifestHash, work: existsSync(bundle) ? 'bundle' : existsSync(work) ? 'files' : 'none' })
    }
    // pulse — re-sign the last heartbeat every heartbeatSeconds so liveness costs
    // the agent zero tokens. progressAt is preserved, so `idle` still surfaces
    // an agent that has gone quiet. Exits once result.json exists or the
    // deadline is 1h past.
    case 'pulse': {
      const every = Number(env.heartbeatSeconds ?? 300) * 1000
      const stop = Date.parse(env.deadline) + 3600000
      while (Date.now() < stop && !existsSync(join(returnDir, 'result.json'))) {
        const hbPath = join(returnDir, 'heartbeat.json')
        const last = existsSync(hbPath) ? readJsonFile(hbPath) : { status: 'working', progress: 'starting', progressAt: new Date().toISOString() }
        heartbeat(last.status, last.progress, last.progressAt)
        sleep(every)
      }
      return
    }
    default:
      usage()
  }
}

// --- ledger ---------------------------------------------------------------

function appendLedger(record) {
  mkdirSync(dirname(ledgerPath), { recursive: true })
  appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`)
}

// Ledger lines are append-only JSONL; a malformed line (hand edits) is skipped,
// never fatal.
function ledgerRecords() {
  if (!existsSync(ledgerPath)) return []
  return readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim()).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function history() {
  const byId = new Map()
  for (const rec of ledgerRecords()) byId.set(rec.dispatchId, { ...(byId.get(rec.dispatchId) ?? {}), ...rec })
  return [...byId.values()].map(({ key, ...rest }) => rest)
}

function ledgerFor(id) {
  const merged = ledgerRecords().filter((r) => r.dispatchId === id).reduce((acc, r) => ({ ...acc, ...r }), null)
  if (!merged?.key) throw new Error(`Unknown dispatch ${id} (not in ${ledgerPath})`)
  return merged
}

function mark(id, status, extra) {
  const rec = { at: new Date().toISOString(), dispatchId: id, status, ...extra }
  appendLedger(rec)
  return rec
}

// --- fleet mode (auto-offload disposition) --------------------------------

function readMode(statePath) {
  const path = statePath || defaultModeState
  if (!existsSync(path)) return { available: false, reminderIntervalMinutes: 30, lastReminderAt: null, statePath: resolve(path), initialized: false }
  const state = readJsonFile(path)
  return { available: Boolean(state.available), reminderIntervalMinutes: Number(state.reminderIntervalMinutes ?? 30), lastReminderAt: state.lastReminderAt ?? null, statePath: resolve(path), initialized: true }
}

function setMode(options) {
  const path = options.get('state') || defaultModeState
  const current = readMode(path)
  const next = {
    available: options.has('available') ? options.get('available') === 'true' : current.available,
    reminderIntervalMinutes: options.has('interval-minutes') ? Number(options.get('interval-minutes')) : current.reminderIntervalMinutes,
    lastReminderAt: options.has('available') ? null : current.lastReminderAt,
  }
  writeJsonFile(path, next)
  return { ...next, statePath: resolve(path) }
}

// reminder-check — hook entrypoint. Emits the nudge only when available AND due.
function reminderCheck(options) {
  const path = options.get('state') || defaultModeState
  const state = readMode(path)
  if (!state.available) return
  const now = Date.now()
  const last = state.lastReminderAt ? Date.parse(state.lastReminderAt) : null
  if (last !== null && Number.isFinite(last) && now - last < state.reminderIntervalMinutes * 60000) return
  writeJsonFile(path, { available: true, reminderIntervalMinutes: state.reminderIntervalMinutes, lastReminderAt: new Date(now).toISOString() })
  const text =
    '[dispatch: fleet available] Before starting significant local work, judge whether this task should be offloaded to a remote worker instead of run here. Offload when it would (a) tie up the local screen / GUI / simulator / browser, (b) consume heavy CPU / RAM / IO, (c) run long, or (d) parallelize cleanly across machines. If so, propose `/dispatch send` to a configured worker rather than running locally. If nothing is configured yet, mention `/dispatch add`. Otherwise proceed locally — do not force offloading.'
  if (options.get('format') === 'json') printJson({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } })
  else process.stdout.write(`${text}\n`)
}

// --- context collection ---------------------------------------------------

function explicitList(root, pathsFile) {
  const excludedSensitive = []
  const candidates = []
  for (const raw of readFileSync(pathsFile, 'utf8').split('\n')) {
    const path = raw.trim()
    if (!path) continue
    assertSafeRelativePath(path)
    if (isSensitiveName(path.split('/').pop())) { excludedSensitive.push(path); continue }
    if (!existsSync(join(root, path))) throw new Error(`Listed context path missing: ${path}`)
    candidates.push(path)
  }
  candidates.sort()
  return { candidates, skippedSymlinks: [], excludedSensitive: excludedSensitive.sort() }
}

function collectFiles(root) {
  const found = { candidates: [], skippedSymlinks: [], excludedSensitive: [] }
  walk(root, root, found)
  found.candidates.sort(); found.skippedSymlinks.sort(); found.excludedSensitive.sort()
  return found
}

function walk(root, directory, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue
    const absolute = join(directory, entry.name)
    const path = relative(root, absolute)
    if (entry.isSymbolicLink()) { found.skippedSymlinks.push(path); continue }
    if (entry.isDirectory()) { walk(root, absolute, found); continue }
    if (!entry.isFile()) continue
    if (isSensitiveName(entry.name)) { found.excludedSensitive.push(path); continue }
    found.candidates.push(path)
  }
}

function isSensitiveName(name) {
  if (!name || sensitiveAllowlist.has(name)) return false
  return name === '.env' || name.startsWith('.env.')
}

// --- ssh / crypto / io ----------------------------------------------------

function ssh(dest, remoteCmd, { input, allowFail = false, timeout = 120000 } = {}) {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', dest, remoteCmd], { input, encoding: input && Buffer.isBuffer(input) ? undefined : 'utf8', timeout, maxBuffer: 1 << 28 })
  if (r.stdout && Buffer.isBuffer(r.stdout)) { r.stdout = r.stdout.toString('utf8'); r.stderr = r.stderr?.toString('utf8') }
  if (r.status !== 0 && !allowFail) throw new Error(`ssh ${dest} '${remoteCmd.slice(0, 80)}' failed (${r.status ?? r.error?.code}): ${(r.stderr ?? '').trim()}`)
  return r
}

function scp(dest, localPaths, remotePath) {
  const r = spawnSync('scp', ['-q', '-o', 'BatchMode=yes', ...localPaths, `${dest}:${remotePath}`], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`scp to ${dest}:${remotePath} failed: ${r.stderr.trim()}`)
}

function scpFrom(dest, remotePath, localPath, recursive = false) {
  const r = spawnSync('scp', ['-q', '-o', 'BatchMode=yes', ...(recursive ? ['-r'] : []), `${dest}:${remotePath}`, localPath], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`scp from ${dest}:${remotePath} failed: ${r.stderr.trim()}`)
}

function writeRemote(dest, remotePath, content, chmod) {
  ssh(dest, `cat > '${remotePath}'${chmod ? ` && chmod ${chmod} '${remotePath}'` : ''}`, { input: content })
}

function sleep(ms) {
  if (ms > 0) spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${Math.round(ms)})`])
}

function hash(data) { return `sha256:${createHash('sha256').update(data).digest('hex')}` }
function hmac(keyHex, message) { return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(message).digest('hex') }
function safeEqualHex(a, b) {
  const ab = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
function assertSafeRelativePath(path) {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes('..')) throw new Error(`Unsafe context path: ${path}`)
}

function parseOptions(args) {
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (!key?.startsWith('--') || value === undefined) usage()
    options.set(key.slice(2), value)
  }
  return options
}
function requiredOption(options, key) {
  const value = options.get(key)
  if (!value) throw new Error(`Missing --${key}`)
  return value
}
function readJsonFile(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function writeJsonFile(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
function printJson(value) { process.stdout.write(`${JSON.stringify(value)}\n`) }
function exitJson({ result, ok }) { printJson(result); process.exitCode = ok ? 0 : 1 }

function usage() {
  process.stderr.write(`usage: node dispatch.mjs <command> [<id>] [--flag value ...]
sender (everything after prepare is resolved from the ledger by <id>):
  discover [worker]                    list agent CLIs on the worker
  check [worker]                       reachable/node/tmux/agent + auth probe; records lastAuthOkAt
  prepare   --worker <name> --root <dir> --prompt-file <f> --gate <text> --out-dir <dir>
            [--paths-file <f>] [--constraints "a;b"] [--ref <branch>] [--return-method ssh-pull|git-branch]
            [--ssh <dest>] [--dispatch-dir <d>] [--heartbeat-seconds N] [--max-stale-seconds N] [--deadline-minutes N] [--sender <id>]
  transfer  <id> [--bundle <f> | --branch <ref> --repo-url <url>]   (default: curated files)
  launch    <id> [--agent "<cmd>"] [--mode interactive|headless] [--settle-seconds N] [--pulse false]
  await-ack <id> [--timeout-seconds 120] [--poll-seconds 20]
  status    <id> [--pane true] [--lines N]
  follow    <id> [--interval-seconds N]        loops until a verdict needs you; run in background
  pane      <id> [--lines N]
  steer     <id> --file <instruction.md> | --keys "<tmux keys>"
  collect   <id> --into <fresh-empty-dir>
  recall    <id> [--purge true]
  mark      <id> --status <collected|failed|...>
  sessions | history
worker (run inside the dispatch dir):
  worker init | ack --understanding .. --plan .. [--will-not-do ..] | heartbeat --status working|blocked --progress ..
  worker done|failed --summary .. [--notes ..] | pulse
primitives: keygen | manifest --root <dir> [--paths-file f] [--out f] | sign --key --in [--out] | verify --key --in
            check-heartbeat --key --in [--max-stale-seconds N] [--deadline iso] | verify-result --key --result [--root d | --bundle f]
fleet mode: mode | set-mode --available true|false [--interval-minutes N] | reminder-check [--format json]
`)
  process.exit(2)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
