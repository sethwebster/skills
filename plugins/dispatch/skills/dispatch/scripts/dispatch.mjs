#!/usr/bin/env node
// dispatch.mjs — deterministic security helper for the /dispatch skill.
// Node stdlib only. Ships to the worker so both sides canonicalize + HMAC identically.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const excludedNames = new Set(['.git', 'node_modules', 'dist', 'build', '.DS_Store'])
const sensitiveAllowlist = new Set(['.env.example', '.env.sample', '.env.template'])

function main() {
  const [command, ...args] = process.argv.slice(2)
  const options = parseOptions(args)

  switch (command) {
    case 'keygen':
      return printJson(keygen())
    case 'manifest':
      return printJson(manifest(options))
    case 'sign':
      return printJson(sign(options))
    case 'verify':
      return exitJson(verify(options))
    case 'check-heartbeat':
      return exitJson(checkHeartbeat(options))
    case 'verify-result':
      return exitJson(verifyResult(options))
    default:
      usage()
  }
}

// --- commands -------------------------------------------------------------

// keygen — mint a per-dispatch id + shared HMAC key. The key rides the SSH
// channel inside the envelope; it authenticates every async leg thereafter.
function keygen() {
  return {
    dispatchId: `dsp-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`,
    key: randomBytes(32).toString('hex'),
    algo: 'HMAC-SHA256',
  }
}

// manifest — content-addressed fingerprint of the *curated* context set.
// --paths-file gives an exact relative-path list (right-sized context); with
// none it walks --root under the same exclusions the sender expects.
function manifest(options) {
  const root = resolve(requiredOption(options, 'root'))
  const pathsFile = options.get('paths-file')
  const { candidates, skippedSymlinks, excludedSensitive } = pathsFile
    ? explicitList(root, pathsFile)
    : collectFiles(root)
  const files = candidates.map((path) => {
    const data = readFileSync(join(root, path))
    return { path, size: data.byteLength, sha256: hash(data) }
  })
  const manifestValue = { version: 1, mode: 'context', files }
  const manifestHash = hash(Buffer.from(canonicalJson(manifestValue)))
  const result = { manifestHash, fileCount: files.length, skippedSymlinks, excludedSensitive }
  if (options.get('out')) {
    writeJsonFile(options.get('out'), { ...manifestValue, manifestHash })
    result.written = resolve(options.get('out'))
  }
  return result
}

// sign — attach an HMAC over the canonical JSON of the message body (minus any
// prior hmac). Used for the dispatch envelope, the ack, heartbeats, results.
function sign(options) {
  const key = requiredOption(options, 'key')
  const body = readJsonFile(requiredOption(options, 'in'))
  delete body.hmac
  const signed = { ...body, hmac: hmac(key, canonicalJson(body)) }
  if (options.get('out')) writeJsonFile(options.get('out'), signed)
  else printJson(signed)
  return { signed: true }
}

// verify — recompute the HMAC and constant-time compare. Any tamper in transit
// (or a party without the key) fails here.
function verify(options) {
  const key = requiredOption(options, 'key')
  const message = readJsonFile(requiredOption(options, 'in'))
  const provided = message.hmac
  const body = { ...message }
  delete body.hmac
  const expected = hmac(key, canonicalJson(body))
  const verified = typeof provided === 'string' && safeEqualHex(provided, expected)
  return { result: { verified, dispatchId: message.dispatchId ?? null, type: message.type ?? null }, ok: verified }
}

// check-heartbeat — verify signature, then judge liveness from updatedAt +
// deadline. Drives the "notified when done, followed up if it goes dark" loop.
function checkHeartbeat(options) {
  const { result: v, ok } = verify(options)
  if (!ok) return { result: { ...v, verdict: 'unverified' }, ok: false }
  const hb = readJsonFile(options.get('in'))
  const now = Date.now()
  const updatedAt = Date.parse(hb.updatedAt ?? '')
  const ageSeconds = Number.isFinite(updatedAt) ? Math.round((now - updatedAt) / 1000) : null
  const maxStale = Number(options.get('max-stale-seconds') ?? 900)
  const deadline = options.get('deadline') ? Date.parse(options.get('deadline')) : null
  let verdict
  if (hb.status === 'done') verdict = 'done'
  else if (hb.status === 'failed' || hb.status === 'blocked') verdict = hb.status
  else if (deadline && now > deadline) verdict = 'expired'
  else if (ageSeconds !== null && ageSeconds > maxStale) verdict = 'dark'
  else verdict = 'alive'
  return {
    result: { verified: true, status: hb.status ?? null, verdict, ageSeconds, maxStale, progress: hb.progress ?? null },
    ok: verdict === 'done' || verdict === 'alive',
  }
}

// verify-result — the returned work's HMAC is valid AND the extracted tree
// re-hashes to the manifest the worker signed. Integrity + authenticity gate
// before any integration.
function verifyResult(options) {
  const key = requiredOption(options, 'key')
  const resultPath = requiredOption(options, 'result')
  const { result: v, ok } = verify(new Map([['key', key], ['in', resultPath]]))
  if (!ok) return { result: { ...v, verdict: 'unverified-signature' }, ok: false }
  const result = readJsonFile(resultPath)
  if (!options.get('root')) return { result: { verified: true, manifestMatch: null, claimed: result.manifestHash ?? null }, ok: true }
  const recomputed = manifest(new Map([['root', options.get('root')]])).manifestHash
  const manifestMatch = typeof result.manifestHash === 'string' && recomputed === result.manifestHash
  return { result: { verified: true, manifestMatch, claimed: result.manifestHash ?? null, recomputed }, ok: manifestMatch }
}

// --- context collection ---------------------------------------------------

function explicitList(root, pathsFile) {
  const skippedSymlinks = []
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
  return { candidates, skippedSymlinks, excludedSensitive: excludedSensitive.sort() }
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

// --- primitives -----------------------------------------------------------

function hash(data) {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

function hmac(keyHex, message) {
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(message).digest('hex')
}

function safeEqualHex(a, b) {
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
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

// --- io / args ------------------------------------------------------------

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

// exitJson — print the result and set exit code from the ok flag so shell
// callers can branch on `&&` without parsing JSON.
function exitJson({ result, ok }) {
  printJson(result)
  process.exitCode = ok ? 0 : 1
}

function usage() {
  process.stderr.write(
    [
      'usage: node dispatch.mjs <command> [--flag value ...]',
      '  keygen',
      '  manifest        --root <dir> [--paths-file <f>] [--out <f>]',
      '  sign            --key <hex> --in <body.json> [--out <f>]',
      '  verify          --key <hex> --in <signed.json>',
      '  check-heartbeat --key <hex> --in <hb.json> [--max-stale-seconds N] [--deadline <iso>]',
      '  verify-result   --key <hex> --result <result.json> [--root <extracted-dir>]',
    ].join('\n') + '\n',
  )
  process.exit(2)
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
