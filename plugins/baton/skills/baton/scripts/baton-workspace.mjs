#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

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
  ].join('\n'))
}

try {
  main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
