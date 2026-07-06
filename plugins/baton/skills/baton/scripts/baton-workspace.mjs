#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const excludedNames = new Set(['.git', 'node_modules', 'dist', 'build', '.DS_Store'])
const sensitiveAllowlist = new Set(['.env.example', '.env.sample', '.env.template'])
const maxBundleBytes = 256 * 1024 * 1024

function main() {
  const [command, ...args] = process.argv.slice(2)
  const options = parseOptions(args)

  if (command === 'git-preflight') {
    printJson(gitPreflight(requiredOption(options, 'workspace')))
    return
  }

  if (command === 'bundle-create') {
    printJson(createBundle({
      workspace: requiredOption(options, 'workspace'),
      bundle: requiredOption(options, 'bundle'),
      manifest: requiredOption(options, 'manifest'),
    }))
    return
  }

  if (command === 'bundle-verify') {
    printJson(verifyBundle({
      bundle: requiredOption(options, 'bundle'),
      manifest: requiredOption(options, 'manifest'),
      output: requiredOption(options, 'output'),
    }))
    return
  }

  if (command === 'workspace-hash') {
    printJson(workspaceHash(requiredOption(options, 'workspace')))
    return
  }

  if (command === 'send') {
    printJson(send(options))
    return
  }

  if (command === 'clean') {
    printJson(clean(options))
    return
  }

  usage()
}

function parseOptions(args) {
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]
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

function gitPreflight(workspace) {
  const root = resolve(workspace)
  if (!existsSync(join(root, '.git'))) return { mode: 'git', available: false, reason: 'NotGitRepository' }
  let head
  try { head = runGit(root, ['rev-parse', 'HEAD']) } catch { return { mode: 'git', available: false, reason: 'NoCommits' } }
  const branch = runGit(root, ['branch', '--show-current'])
  const status = runGit(root, ['status', '--porcelain=v1'])
  return {
    mode: 'git',
    available: true,
    branch,
    head,
    dirty: status.length > 0,
    handoffBranchCommand: `git switch -c handoff/${head.slice(0, 12)}`,
    pushCommand: `git push -u origin handoff/${head.slice(0, 12)}`,
  }
}

function computeManifest(root, { withData }) {
  const { candidates, skippedSymlinks, excludedSensitive } = collectFiles(root)
  const excludedIgnored = listGitIgnored(root, candidates)
  const ignoredSet = new Set(excludedIgnored)
  let totalBytes = 0
  const entries = candidates.filter((path) => !ignoredSet.has(path)).map((path) => {
    const data = readFileSync(join(root, path))
    totalBytes += data.byteLength
    if (withData && totalBytes > maxBundleBytes) throw new Error('Workspace too large for JSON bundle (>256MiB): use GitHub branch handoff instead')
    const entry = { path, size: data.byteLength, sha256: hash(data) }
    if (withData) entry.data = data.toString('base64')
    return entry
  })
  const manifestValue = {
    version: 2,
    mode: 'bundle',
    files: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  }
  const manifestHash = hash(Buffer.from(canonicalJson(manifestValue)))
  return { entries, manifestValue, manifestHash, skippedSymlinks, excludedSensitive, excludedIgnored }
}

function createBundle({ workspace, bundle, manifest }) {
  const root = resolve(workspace)
  const { entries, manifestValue, manifestHash, skippedSymlinks, excludedSensitive, excludedIgnored } = computeManifest(root, { withData: true })
  const bundleValue = { version: 1, manifestHash, files: entries }
  writeJsonFile(manifest, manifestValue)
  writeJsonFile(bundle, bundleValue)
  return { mode: 'bundle', fileCount: entries.length, manifestHash, skippedSymlinks, excludedSensitive, excludedIgnored }
}

function workspaceHash(workspace) {
  const root = resolve(workspace)
  const { manifestValue, manifestHash, skippedSymlinks, excludedSensitive, excludedIgnored } = computeManifest(root, { withData: false })
  const preflight = gitPreflight(root)
  const git = preflight.available ? { head: preflight.head, branch: preflight.branch, dirty: preflight.dirty } : null
  return { mode: 'hash', manifestHash, fileCount: manifestValue.files.length, git, skippedSymlinks, excludedSensitive, excludedIgnored }
}

// allow: SIZE_OK - this script is intentionally self-contained because it is piped over ssh for remote verification.
function send(options) {
  const context = sendContext(options)
  const steps = []
  const record = (id, status, details = {}) => {
    const step = { id, status, ...details }
    steps.push(step)
    return step
  }
  const finish = (status, reason, details = {}) => {
    const output = { command: 'send', status, reason, mode: context.mode, partner: context.partnerName, steps, ...details }
    writeEvidence(context, output)
    appendLedger(context.ledgerPath, {
      direction: 'sent',
      partner: context.partnerName,
      ssh: context.facts.ssh ?? null,
      mode: context.mode,
      workspace: context.workspace,
      remoteDir: context.facts.remoteDir ?? null,
      manifestHash: context.facts.manifestHash ?? null,
      git: context.facts.git ?? null,
      tmuxSession: context.facts.tmuxSession ?? null,
      receiverCommand: context.facts.receiverCommand ?? null,
      status,
      reason,
    })
    return output
  }

  try {
    record('config-lookup', 'completed', { path: context.configPath })
    const partner = resolvePartner(context.configPath, context.partnerName)
    context.partnerName = partner.name
    context.facts.ssh = partner.ssh
    context.facts.receiverCommand = partner.receiverCommand
    record('partner-resolve', 'completed', { partner: partner.name, ssh: partner.ssh })

    const handoff = validateHandoff(context)
    if (!handoff.valid) return finish('blocked', handoff.reason)
    record('handoff-validate', 'completed', { path: context.handoffPath })

    record('partner-check-command', context.dryRun ? 'planned' : 'completed', { command: partnerCheckCommand(partner) })
    if (!context.dryRun) runShell(partnerCheckCommand(partner))
    record('agent-discovery-command', context.dryRun ? 'planned' : 'completed', { command: agentDiscoveryCommand(partner) })
    if (!context.dryRun) runShell(agentDiscoveryCommand(partner))

    const hashOutput = workspaceHash(context.workspace)
    context.facts.manifestHash = hashOutput.manifestHash
    context.facts.git = hashOutput.git
    record('workspace-hash', 'completed', { manifestHash: hashOutput.manifestHash, git: hashOutput.git })
    const preflight = gitPreflight(context.workspace)
    record('git-preflight', 'completed', { available: preflight.available, dirty: preflight.dirty ?? null })
    if (context.mode === 'github-branch') return finish('blocked', 'git_mode_requires_operator')

    const paths = sendPaths(context, partner, hashOutput.manifestHash)
    context.facts.remoteDir = paths.remoteDir
    context.facts.tmuxSession = paths.tmuxSession
    let bundleOutput = null
    if (context.dryRun) {
      bundleOutput = { fileCount: hashOutput.fileCount, manifestHash: hashOutput.manifestHash, skippedSymlinks: hashOutput.skippedSymlinks, excludedSensitive: hashOutput.excludedSensitive, excludedIgnored: hashOutput.excludedIgnored }
      record('bundle-create', 'planned', { bundle: paths.bundlePath, manifest: paths.manifestPath, manifestHash: bundleOutput.manifestHash })
    } else {
      bundleOutput = createBundle({ workspace: context.workspace, bundle: paths.bundlePath, manifest: paths.manifestPath })
      record('bundle-create', 'completed', { bundle: paths.bundlePath, manifest: paths.manifestPath, manifestHash: bundleOutput.manifestHash })
    }
    if (bundleOutput.excludedSensitive.length > 0) return finish('blocked', 'excluded_sensitive_files', { excludedSensitive: bundleOutput.excludedSensitive })

    const scp = scpCommand(partner, paths)
    record('scp-transfer-command', context.dryRun ? 'planned' : 'completed', { command: scp })
    if (!context.dryRun) runShell(scp)

    const remoteVerify = remoteVerifyCommand(partner, paths)
    if (context.failStep === 'remote-bundle-verify-command') {
      record('remote-bundle-verify-command', 'failed', { command: remoteVerify })
      return finish('failed', 'remote_bundle_verify_failed')
    }
    record('remote-bundle-verify-command', context.dryRun ? 'planned' : 'completed', { command: remoteVerify })
    if (!context.dryRun) runShell(remoteVerify)

    const tmuxLaunch = tmuxLaunchCommand(partner, paths)
    record('tmux-launch-command', context.dryRun ? 'planned' : 'completed', { command: tmuxLaunch })
    if (!context.dryRun) runShell(tmuxLaunch)
    const tmuxCheck = tmuxSessionCheckCommand(partner, paths)
    record('tmux-session-check-command', context.dryRun ? 'planned' : 'completed', { command: tmuxCheck })
    if (!context.dryRun) runShell(tmuxCheck)
    const paneCapture = paneCaptureCommand(partner, paths)
    record('tmux-pane-capture-command', context.dryRun ? 'planned' : 'completed', { command: paneCapture })
    const pane = context.dryRun ? '' : runShell(paneCapture)
    if (pane.toLowerCase().includes('trust')) return finish('needs_operator', 'receiver_trust_prompt', sendResultDetails(paths, bundleOutput.manifestHash))

    const promptInject = promptInjectionCommand(partner, paths, bundleOutput.manifestHash)
    record('prompt-injection-command', context.dryRun ? 'planned' : 'completed', { command: promptInject })
    if (!context.dryRun) runShell(promptInject)
    const ackPane = context.dryRun ? '' : runShell(paneCapture)
    const ack = validateReceiverAck(ackPane, paths.remoteDir, bundleOutput.manifestHash)
    record('receiver-ack-validation', ack.valid ? 'completed' : 'needs_operator', { required: ack.required })
    if (!ack.valid) return finish('needs_operator', context.dryRun ? 'dry_run_receiver_ack_required' : 'receiver_ack_incomplete', sendResultDetails(paths, bundleOutput.manifestHash))
    return finish('released', 'receiver_ack_valid', sendResultDetails(paths, bundleOutput.manifestHash))
  } catch (error) {
    return finish('failed', 'deterministic_command_failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

function clean(options) {
  const context = cleanContext(options)
  const steps = []
  const record = (id, status, details = {}) => steps.push({ id, status, ...details })
  const finish = (status, reason, details = {}) => {
    const output = { command: 'clean', status, reason, partner: context.partnerName, steps, ...details }
    if (status === 'cleaned') {
      appendLedger(context.ledgerPath, {
        direction: 'cleaned',
        partner: context.partnerName,
        ssh: context.facts.ssh ?? null,
        remoteDir: context.facts.remoteDir ?? null,
        recordedManifestHash: context.facts.recordedManifestHash ?? null,
        remoteManifestHash: context.facts.remoteManifestHash ?? null,
        verdict: context.facts.verdict ?? null,
        forced: context.facts.forced ?? false,
        status,
        reason,
      })
    }
    return output
  }

  try {
    record('config-lookup', 'completed', { path: context.configPath })
    const partner = resolvePartner(context.configPath, context.partnerName)
    context.partnerName = partner.name
    context.facts.ssh = partner.ssh
    record('partner-resolve', 'completed', { partner: partner.name, ssh: partner.ssh })

    const ledgerRecord = latestLedgerRecord(context.ledgerPath, partner.name)
    if (!ledgerRecord) return finish('blocked', 'no_ledger_record')
    context.facts.remoteDir = ledgerRecord.remoteDir
    context.facts.recordedManifestHash = ledgerRecord.manifestHash
    record('ledger-lookup', 'completed', { at: ledgerRecord.at, remoteDir: ledgerRecord.remoteDir, manifestHash: ledgerRecord.manifestHash })

    if (!remoteDirIsSafe(ledgerRecord.remoteDir, partner.handoffDir)) return finish('blocked', 'unsafe_remote_dir', { remoteDir: ledgerRecord.remoteDir })
    record('remote-dir-safety', 'completed', { remoteDir: ledgerRecord.remoteDir })

    const existsCommand = remoteExistsCommand(partner, ledgerRecord.remoteDir)
    record('remote-exists-command', context.dryRun ? 'planned' : 'completed', { command: existsCommand })
    if (context.failStep === 'remote-exists-command') return finish('completed', 'nothing_to_clean')
    if (!context.dryRun && runShell(existsCommand) === 'absent') return finish('completed', 'nothing_to_clean')

    const hashCommand = remoteHashCommand(partner, ledgerRecord.remoteDir)
    record('remote-hash-command', context.dryRun ? 'planned' : 'completed', { command: hashCommand })
    const remoteHash = context.assumeRemoteHash ?? (context.dryRun ? null : JSON.parse(runShell(hashCommand)).manifestHash)
    if (remoteHash === null) return finish('needs_operator', 'dry_run_remote_state_unknown')
    context.facts.remoteManifestHash = remoteHash

    const verdict = remoteHash === ledgerRecord.manifestHash ? 'unchanged' : 'remote-ahead'
    context.facts.verdict = verdict
    record('divergence-verdict', 'completed', { verdict, recorded: ledgerRecord.manifestHash, remote: remoteHash })
    if (verdict !== 'unchanged' && !context.force) {
      return finish('blocked', 'remote_ahead_requires_force', { verdict, recorded: ledgerRecord.manifestHash, remote: remoteHash })
    }
    context.facts.forced = verdict !== 'unchanged'

    const removeCommand = remoteRemoveCommand(partner, ledgerRecord.remoteDir)
    record('remote-remove-command', context.dryRun ? 'planned' : 'completed', { command: removeCommand, forced: context.facts.forced })
    if (context.dryRun) return finish('needs_operator', 'dry_run_remove_not_executed', { verdict })
    runShell(removeCommand)
    return finish('cleaned', 'remote_workspace_removed', { verdict, remoteDir: ledgerRecord.remoteDir })
  } catch (error) {
    return finish('failed', 'deterministic_command_failed', { error: error instanceof Error ? error.message : String(error) })
  }
}

function cleanContext(options) {
  return {
    configPath: resolve(requiredOption(options, 'config')),
    ledgerPath: resolve(requiredOption(options, 'ledger')),
    partnerName: options.get('partner') ?? null,
    dryRun: options.get('dry-run') === 'true',
    force: options.get('force') === 'true',
    failStep: options.get('fail-step') ?? null,
    assumeRemoteHash: options.get('assume-remote-hash') ?? null,
    facts: {},
  }
}

function latestLedgerRecord(ledgerPath, partnerName) {
  if (!existsSync(ledgerPath)) return null
  const records = readFileSync(ledgerPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  return records.findLast((record) =>
    record.partner === partnerName && record.direction !== 'cleaned' && record.remoteDir && record.manifestHash) ?? null
}

function remoteDirIsSafe(remoteDir, handoffDir) {
  if (typeof remoteDir !== 'string' || typeof handoffDir !== 'string') return false
  const inbox = handoffDir.replace(/\/$/u, '')
  if (inbox === '' || inbox === '/' || inbox === '~') return false
  if (!remoteDir.startsWith(`${inbox}/`)) return false
  if (remoteDir.split(/[\/]/u).includes('..')) return false
  return remoteDir.includes('baton-') && remoteDir.endsWith('-workspace')
}

function remoteExistsCommand(partner, remoteDir) {
  return `ssh ${shellWord(partner.ssh)} ${shellWord(`test -d ${remotePathWord(remoteDir)} && echo exists || echo absent`)}`
}

function remoteHashCommand(partner, remoteDir) {
  return `ssh ${shellWord(partner.ssh)} ${shellWord(`node --input-type=module - workspace-hash --workspace ${remotePathWord(remoteDir)}`)} < ${shellWord(fileURLToPath(import.meta.url))}`
}

function remoteRemoveCommand(partner, remoteDir) {
  return `ssh ${shellWord(partner.ssh)} ${shellWord(`rm -rf -- ${remotePathWord(remoteDir)}`)}`
}

function appendLedger(ledgerPath, record) {
  if (!ledgerPath) return
  mkdirSync(dirname(ledgerPath), { recursive: true })
  appendFileSync(ledgerPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`)
}

function verifyBundle({ bundle, manifest, output }) {
  const bundleValue = readJsonFile(bundle)
  const manifestValue = readJsonFile(manifest)
  if (bundleValue.manifestHash !== hash(Buffer.from(canonicalJson(manifestValue)))) throw new Error('Manifest hash mismatch')
  const files = manifestValue.files
  if (!Array.isArray(files) || !Array.isArray(bundleValue.files)) throw new Error('Invalid bundle shape')
  const bundleByPath = new Map(bundleValue.files.map((file) => [file.path, file]))
  const outputRoot = resolve(output)
  if (existsSync(outputRoot) && readdirSync(outputRoot).length > 0) throw new Error(`Output directory not empty: ${outputRoot}`)
  mkdirSync(outputRoot, { recursive: true })
  for (const expected of files) {
    assertSafeRelativePath(expected.path)
    const received = bundleByPath.get(expected.path)
    if (!received) throw new Error(`Missing bundled file: ${expected.path}`)
    const data = Buffer.from(received.data, 'base64')
    if (data.byteLength !== expected.size || hash(data) !== expected.sha256) throw new Error(`Hash mismatch: ${expected.path}`)
    const target = join(outputRoot, expected.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
  }
  return { verified: true, fileCount: files.length, manifestHash: bundleValue.manifestHash }
}

function sendContext(options) {
  const workspace = resolve(requiredOption(options, 'workspace'))
  const evidenceDir = resolve(requiredOption(options, 'evidence-dir'))
  const mode = options.get('mode') ?? 'scp-bundle'
  if (mode !== 'scp-bundle' && mode !== 'github-branch') throw new Error(`Unsupported --mode: ${mode}`)
  return {
    workspace,
    configPath: resolve(requiredOption(options, 'config')),
    handoffPath: resolve(requiredOption(options, 'handoff')),
    evidenceDir,
    mode,
    partnerName: options.get('partner') ?? null,
    dryRun: options.get('dry-run') === 'true',
    failStep: options.get('fail-step') ?? null,
    runId: options.get('run-id') ?? timestampSlug(new Date()),
    ledgerPath: options.get('ledger') ? resolve(options.get('ledger')) : null,
    facts: {},
  }
}

function resolvePartner(configPath, partnerName) {
  const config = readJsonFile(configPath)
  const name = partnerName ?? config.defaultHost
  if (!name) throw new Error('No partner specified and config has no defaultHost')
  const partner = config.hosts?.[name]
  if (!partner?.ssh) throw new Error(`Unknown partner: ${name}`)
  return { name, ssh: partner.ssh, handoffDir: partner.handoffDir ?? '~/baton-inbox', receiverCommand: partner.receiverCommand ?? 'claude --remote-control' }
}

function validateHandoff({ workspace, handoffPath }) {
  const relativePath = relative(workspace, handoffPath)
  if (isAbsolute(relativePath) || relativePath.split(/[\/]/u).includes('..')) return { valid: false, reason: 'handoff_outside_workspace' }
  if (!existsSync(handoffPath)) return { valid: false, reason: 'handoff_missing' }
  return { valid: true }
}

function sendPaths(context, partner, manifestHash) {
  const safePartner = partner.name.replace(/[^a-zA-Z0-9_-]/gu, '-')
  const safeRunId = context.runId.replace(/[^a-zA-Z0-9_-]/gu, '-')
  const hashId = manifestHash.replace(/^sha256:/u, '').slice(0, 12)
  const tmuxSession = `baton-${safePartner}-${safeRunId || hashId}`
  const remoteDir = `${partner.handoffDir.replace(/\/$/u, '')}/${tmuxSession}-workspace`
  return {
    tmuxSession,
    remoteDir,
    remoteBundle: `${partner.handoffDir}/workspace.bundle.json`,
    remoteManifest: `${partner.handoffDir}/workspace.manifest.json`,
    remoteScript: `${partner.handoffDir}/baton-workspace.mjs`,
    bundlePath: join(context.evidenceDir, 'workspace.bundle.json'),
    manifestPath: join(context.evidenceDir, 'workspace.manifest.json'),
    evidencePath: join(context.evidenceDir, `baton-send-${safePartner}.json`),
    attachCommand: `ssh -t ${partner.ssh} 'tmux attach -t ${tmuxSession}'`,
  }
}

function partnerCheckCommand(partner) {
  return `ssh ${shellWord(partner.ssh)} ${shellWord(`node --version && tmux -V && command -v ${shellWord(firstWord(partner.receiverCommand))}`)}`
}

function agentDiscoveryCommand(partner) {
  const script = 'bash -lc \'for c in claude opencode codex gemini hermes openclaw amp aider goose; do command -v "$c" >/dev/null 2>&1 && echo "$c"; done; true\''
  return `ssh ${shellWord(partner.ssh)} ${shellWord(script)}`
}

function scpCommand(partner, paths) {
  return `scp ${shellWord(paths.bundlePath)} ${shellWord(paths.manifestPath)} ${shellWord(fileURLToPath(import.meta.url))} ${shellWord(`${partner.ssh}:${partner.handoffDir}/`)}`
}

function remoteVerifyCommand(partner, paths) {
  return `ssh ${shellWord(partner.ssh)} ${shellWord(`node ${remotePathWord(paths.remoteScript)} bundle-verify --bundle ${remotePathWord(paths.remoteBundle)} --manifest ${remotePathWord(paths.remoteManifest)} --output ${remotePathWord(paths.remoteDir)}`)}`
}

function tmuxLaunchCommand(partner, paths) {
  return `ssh ${shellWord(partner.ssh)} ${shellWord(`cd ${remotePathWord(paths.remoteDir)} && tmux new-session -d -s ${shellWord(paths.tmuxSession)} ${shellWord(partner.receiverCommand)}`)}`
}

function tmuxSessionCheckCommand(partner, paths) {
  return `ssh ${shellWord(partner.ssh)} ${shellWord(`tmux has-session -t ${shellWord(paths.tmuxSession)}`)}`
}

function paneCaptureCommand(partner, paths) {
  return `ssh ${shellWord(partner.ssh)} ${shellWord(`tmux capture-pane -p -t ${shellWord(paths.tmuxSession)}`)}`
}

function promptInjectionCommand(partner, paths, manifestHash) {
  const prompt = [
    'I am handing off a verified Baton workspace.',
    `Workspace: ${paths.remoteDir}`,
    'Mode: scp-bundle',
    `Manifest: ${manifestHash}`,
    'Read HANDOFF.md, then reply with: I am the receiver, workspace path, manifest hash, task understanding, next step, what you will not do, verification gate, readiness status.',
  ].join('\n')
  return `ssh ${shellWord(partner.ssh)} ${shellWord(`tmux send-keys -t ${shellWord(paths.tmuxSession)} ${shellWord(prompt)} Enter`)}`
}

function validateReceiverAck(text, remoteDir, manifestHash) {
  const required = ['I am the receiver', remoteDir, manifestHash, 'next step', 'verification gate']
  return { valid: required.every((value) => text.includes(value)), required }
}

function sendResultDetails(paths, manifestHash) {
  return { manifestHash, evidencePath: paths.evidencePath, attachCommand: paths.attachCommand, remoteDir: paths.remoteDir }
}

function writeEvidence(context, output) {
  if (!context.evidenceDir) return
  mkdirSync(context.evidenceDir, { recursive: true })
  const partner = output.partner ?? 'unknown'
  const evidencePath = output.evidencePath ?? join(context.evidenceDir, `baton-send-${partner}.json`)
  writeJsonFile(evidencePath, { at: new Date().toISOString(), ...output })
}

function runShell(command) {
  return execFileSync('sh', ['-lc', command], { encoding: 'utf8' }).trim()
}

function firstWord(command) {
  return command.trim().split(/\s+/u)[0] ?? command
}

function shellWord(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function remotePathWord(path) {
  if (path === '~') return '$HOME'
  if (path.startsWith('~/')) return `$HOME/${shellWord(path.slice(2))}`
  return shellWord(path)
}

function timestampSlug(date) {
  return date.toISOString().replace(/[-:.TZ]/gu, '').slice(0, 14)
}

function collectFiles(root) {
  const found = { candidates: [], skippedSymlinks: [], excludedSensitive: [] }
  walk(root, root, found)
  found.candidates.sort()
  found.skippedSymlinks.sort()
  found.excludedSensitive.sort()
  return found
}

function walk(root, directory, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (excludedNames.has(entry.name)) continue
    const absolute = join(directory, entry.name)
    const path = relative(root, absolute)
    if (entry.isSymbolicLink()) {
      found.skippedSymlinks.push(path)
      continue
    }
    if (entry.isDirectory()) {
      walk(root, absolute, found)
      continue
    }
    if (!entry.isFile()) continue
    if (isSensitiveName(entry.name)) {
      found.excludedSensitive.push(path)
      continue
    }
    found.candidates.push(path)
  }
}

function isSensitiveName(name) {
  if (sensitiveAllowlist.has(name)) return false
  return name === '.env' || name.startsWith('.env.')
}

function listGitIgnored(root, candidates) {
  if (!existsSync(join(root, '.git')) || candidates.length === 0) return []
  try {
    const output = execFileSync('git', ['-C', root, 'check-ignore', '--stdin'], { encoding: 'utf8', input: `${candidates.join('\n')}\n` })
    return output.split('\n').filter(Boolean)
  } catch (error) {
    if (error && typeof error === 'object' && error.status === 1) return []
    throw error
  }
}

function assertSafeRelativePath(path) {
  if (isAbsolute(path) || path.split(/[\\/]/u).includes('..')) throw new Error(`Unsafe bundled path: ${path}`)
}

function runGit(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

function hash(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function usage() {
  throw new Error([
    'usage:',
    '  baton-workspace.mjs git-preflight --workspace <path>',
    '  baton-workspace.mjs bundle-create --workspace <path> --bundle <path> --manifest <path>',
    '  baton-workspace.mjs bundle-verify --bundle <path> --manifest <path> --output <path>',
    '  baton-workspace.mjs workspace-hash --workspace <path>',
    '  baton-workspace.mjs send --workspace <path> --config <path> --handoff <path> --evidence-dir <path> --mode scp-bundle [--partner <name>] [--dry-run true] [--run-id <id>] [--ledger <path>]',
    '  baton-workspace.mjs clean --config <path> --ledger <path> [--partner <name>] [--dry-run true] [--force true]',
  ].join('\n'))
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
