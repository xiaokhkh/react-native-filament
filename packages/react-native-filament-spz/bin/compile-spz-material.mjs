#!/usr/bin/env node
import {
  accessSync,
  chmodSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import https from 'node:https'

const scriptFile = fileURLToPath(import.meta.url)
const packageRoot = resolve(dirname(scriptFile), '..')
const repoRoot = resolve(packageRoot, '..', '..')
const defaultMaterial = resolve(repoRoot, 'package/assets/spz_gaussian_splat.mat')
const defaultOutput = resolve(repoRoot, 'package/assets/spz_gaussian_splat.filamat')
const toolCacheRoot = resolve(repoRoot, '.codex_tmp/filament-tools')
const networkTimeoutMs = 120_000
const defaultMatcTimeoutMs = 120_000

function printHelp() {
  console.log(`Usage: compile-spz-material [options]

Compiles the react-native-filament SPZ Gaussian Splat material with Filament matc.

Options:
  --mat <path>                 Input .mat file. Default: package/assets/spz_gaussian_splat.mat.
  --output <path>              Output .filamat file. Default: package/assets/spz_gaussian_splat.filamat.
  --matc <path>                Explicit Filament matc binary path. MATC and FILAMENT_MATC env vars are also supported.
  --platform <name>            matc platform. Default: mobile.
  --api <name>                 matc API target. Default: all.
  --check                      Verify the .filamat is at least as new as the .mat source, without compiling.
  --diagnose-matc              Print launch/signing diagnostics for the selected matc binary, without compiling.
  --download-tools             Download official Filament release tools when no local matc is found.
  --download-maven-matc        Download official Maven Central matc when no local matc is found.
  --filament-version <tag>     Filament release tag for --download-tools. Default: latest.
  --matc-timeout-ms <ms>       Maximum time to wait for matc. Default: ${defaultMatcTimeoutMs}.
  --help                       Show this help.

Examples:
  MATC=/path/to/filament/out/cmake-release/tools/matc/matc compile-spz-material
  compile-spz-material --download-tools --filament-version v1.64.0
  compile-spz-material --download-maven-matc --filament-version 1.50.0
`)
}

function parseArgs(argv) {
  const options = {
    api: 'all',
    downloadMavenMatc: false,
    downloadTools: false,
    filamentVersion: 'latest',
    material: defaultMaterial,
    output: defaultOutput,
    platform: 'mobile',
    matcTimeoutMs: defaultMatcTimeoutMs,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[index]
    }

    switch (arg) {
      case '--api':
        options.api = next()
        break
      case '--check':
        options.check = true
        break
      case '--diagnose-matc':
        options.diagnoseMatc = true
        break
      case '--download-tools':
        options.downloadTools = true
        break
      case '--download-maven-matc':
        options.downloadMavenMatc = true
        break
      case '--filament-version':
        options.filamentVersion = next()
        break
      case '--help':
      case '-h':
        options.help = true
        break
      case '--mat':
        options.material = resolvePath(next())
        break
      case '--matc':
        options.matc = resolvePath(next())
        break
      case '--matc-timeout-ms':
        options.matcTimeoutMs = parsePositiveInteger(next(), '--matc-timeout-ms')
        break
      case '--output':
      case '--out':
        options.output = resolvePath(next())
        break
      case '--platform':
        options.platform = next()
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

function resolvePath(filePath) {
  return isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath)
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function canExecute(filePath) {
  try {
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return false
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function formatRelative(filePath) {
  return relative(repoRoot, filePath) || filePath
}

function formatDate(mtimeMs) {
  return new Date(mtimeMs).toISOString()
}

function checkMaterialFreshness(options) {
  if (!existsSync(options.material)) {
    throw new Error(`Input material does not exist: ${options.material}`)
  }
  if (!existsSync(options.output)) {
    throw new Error(
      `Compiled material is missing: ${formatRelative(options.output)}. Run compile-spz-material to create it.`,
    )
  }

  const sourceStat = statSync(options.material)
  const outputStat = statSync(options.output)
  const staleToleranceMs = 1000
  if (outputStat.mtimeMs + staleToleranceMs < sourceStat.mtimeMs) {
    throw new Error(
      [
        `Compiled material is stale: ${formatRelative(options.output)}`,
        `  source: ${formatRelative(options.material)} modified ${formatDate(sourceStat.mtimeMs)}`,
        `  output: ${formatRelative(options.output)} modified ${formatDate(outputStat.mtimeMs)}`,
        'Run compile-spz-material after changing the .mat source, otherwise RNF will keep rendering with the old shader.',
      ].join('\n'),
    )
  }

  console.log(
    `Compiled material is fresh: ${formatRelative(options.output)} >= ${formatRelative(options.material)}`,
  )
}

function pathCandidates(binaryName) {
  return (process.env.PATH ?? '')
    .split(':')
    .filter(Boolean)
    .map((entry) => resolve(entry, binaryName))
}

function findExecutables(root, name, maxDepth = 6) {
  if (!existsSync(root)) return []
  const queue = [{ path: root, depth: 0 }]
  const executables = []

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break

    let entries = []
    try {
      entries = readdirSync(current.path, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const entryPath = join(current.path, entry.name)
      if (entry.isFile() && entry.name === name && canExecute(entryPath)) executables.push(entryPath)
      if (entry.isDirectory() && current.depth < maxDepth) {
        queue.push({ path: entryPath, depth: current.depth + 1 })
      }
    }
  }

  return executables
}

function executableArchitecture(filePath) {
  const result = spawnSync('file', [filePath], { encoding: 'utf8', timeout: 5000 })
  if (result.status !== 0 || result.stdout == null) return undefined
  const output = result.stdout.toLowerCase()
  if (output.includes('arm64')) return 'arm64'
  if (output.includes('x86_64')) return 'x86_64'
  return undefined
}

function versionScore(filePath) {
  const match = filePath.match(/[/\\]v(\d+)\.(\d+)\.(\d+)(?:[/\\]|$)/)
  if (!match) return 0
  return Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3])
}

function hostArchitecture() {
  if (process.arch === 'arm64') return 'arm64'
  if (process.arch === 'x64') return 'x86_64'
  return process.arch
}

function findBestExecutable(root, name, maxDepth = 6) {
  const executables = findExecutables(root, name, maxDepth)
  if (executables.length === 0) return undefined
  const expectedArch = hostArchitecture()
  return executables
    .map((filePath) => {
      const arch = executableArchitecture(filePath)
      const archScore = arch === expectedArch ? 1_000_000_000 : arch == null ? 0 : -1_000_000_000
      return { filePath, score: archScore + versionScore(filePath) }
    })
    .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))[0]?.filePath
}

function findLocalMatc(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.MATC,
    process.env.FILAMENT_MATC,
    resolve(repoRoot, 'filament/out/cmake-release/tools/matc/matc'),
    resolve(repoRoot, 'filament/out/cmake-debug/tools/matc/matc'),
    ...pathCandidates('matc'),
  ]

  for (const candidate of candidates) {
    if (candidate && canExecute(candidate)) return candidate
  }

  return findBestExecutable(toolCacheRoot, 'matc')
}

function requestJson(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'react-native-filament-spz-material-compiler',
        },
      },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume()
          requestJson(response.headers.location).then(resolvePromise, rejectPromise)
          return
        }

        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 400) {
            rejectPromise(new Error(`GitHub request failed (${response.statusCode}): ${body.slice(0, 240)}`))
            return
          }
          try {
            resolvePromise(JSON.parse(body))
          } catch (error) {
            rejectPromise(error)
          }
        })
      },
    )
    request.setTimeout(networkTimeoutMs, () => {
      request.destroy(new Error(`Request timed out after ${networkTimeoutMs / 1000}s: ${url}`))
    })
    request.on('error', rejectPromise)
  })
}

function downloadFile(url, outputPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = https.get(
      url,
      {
        headers: {
          'User-Agent': 'react-native-filament-spz-material-compiler',
        },
      },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume()
          downloadFile(response.headers.location, outputPath).then(resolvePromise, rejectPromise)
          return
        }

        if ((response.statusCode ?? 500) >= 400) {
          response.resume()
          rejectPromise(new Error(`Download failed (${response.statusCode})`))
          return
        }

        const file = createWriteStream(outputPath)
        response.pipe(file)
        file.on('finish', () => {
          file.close(resolvePromise)
        })
        file.on('error', rejectPromise)
      },
    )
    request.setTimeout(networkTimeoutMs, () => {
      request.destroy(new Error(`Download timed out after ${networkTimeoutMs / 1000}s: ${url}`))
    })
    request.on('error', rejectPromise)
  })
}

function releasePlatformToken() {
  if (process.platform === 'darwin') return 'mac'
  if (process.platform === 'linux') return 'linux'
  throw new Error(`--download-tools is only supported on macOS and Linux, current platform is ${process.platform}`)
}

function normalizeFilamentVersion(version) {
  return version.startsWith('v') ? version.slice(1) : version
}

function mavenMatcClassifier() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'osx-aarch_64'
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x86_64'
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x86_64'
  throw new Error(`Maven matc download is not supported on ${process.platform}/${process.arch}`)
}

async function downloadMavenMatc(version) {
  if (version === 'latest') {
    throw new Error('--download-maven-matc requires an explicit --filament-version, for example 1.72.0')
  }

  const mavenVersion = normalizeFilamentVersion(version)
  const classifier = mavenMatcClassifier()
  const cacheDir = resolve(toolCacheRoot, `maven-${mavenVersion}-${classifier}`)
  const cachedMatc = resolve(cacheDir, process.platform === 'win32' ? 'matc.exe' : 'matc')
  if (canExecute(cachedMatc)) return cachedMatc

  mkdirSync(cacheDir, { recursive: true })
  const fileName = `matc-${mavenVersion}-${classifier}.exe`
  const url = `https://repo1.maven.org/maven2/com/google/android/filament/matc/${mavenVersion}/${fileName}`
  const temporaryDownload = resolve(cacheDir, `${fileName}.download`)
  console.log(`Downloading Filament matc ${mavenVersion} from Maven Central: ${fileName}`)
  await downloadFile(url, temporaryDownload)
  renameSync(temporaryDownload, cachedMatc)
  chmodSync(cachedMatc, 0o755)
  return cachedMatc
}

async function downloadMatc(version) {
  const releaseUrl =
    version === 'latest'
      ? 'https://api.github.com/repos/google/filament/releases/latest'
      : `https://api.github.com/repos/google/filament/releases/tags/${encodeURIComponent(version)}`
  const release = await requestJson(releaseUrl)
  const tagName = release.tag_name ?? version
  const cacheDir = resolve(toolCacheRoot, tagName)
  const cachedMatc = findBestExecutable(cacheDir, 'matc')
  if (cachedMatc) return cachedMatc

  const platformToken = releasePlatformToken()
  const assets = Array.isArray(release.assets) ? release.assets : []
  const asset = assets.find((item) => {
    const name = String(item.name ?? '').toLowerCase()
    return name.endsWith('.tgz') && name.includes(platformToken)
  })

  if (!asset?.browser_download_url) {
    const names = assets.map((item) => item.name).filter(Boolean).join(', ')
    throw new Error(`No Filament ${platformToken} .tgz tool asset found for ${tagName}. Available assets: ${names}`)
  }

  mkdirSync(cacheDir, { recursive: true })
  const archivePath = resolve(cacheDir, asset.name)
  console.log(`Downloading Filament tools ${tagName}: ${asset.name}`)
  await downloadFile(asset.browser_download_url, archivePath)

  const extractResult = spawnSync('tar', ['-xzf', archivePath, '-C', cacheDir], { stdio: 'inherit' })
  if (extractResult.status !== 0) {
    throw new Error(`tar failed while extracting ${archivePath}`)
  }

  const extractedMatc = findBestExecutable(cacheDir, 'matc')
  if (!extractedMatc) {
    throw new Error(`Downloaded Filament tools did not contain an executable matc under ${cacheDir}`)
  }

  return extractedMatc
}

function runMatc(matcPath, options) {
  if (!existsSync(options.material)) {
    throw new Error(`Input material does not exist: ${options.material}`)
  }

  mkdirSync(dirname(options.output), { recursive: true })
  const temporaryOutput = `${options.output}.tmp-${process.pid}`
  const args = ['--platform', options.platform, '--api', options.api, '-o', temporaryOutput, options.material]
  const result = spawnSync(matcPath, args, { stdio: 'inherit', timeout: options.matcTimeoutMs, killSignal: 'SIGTERM' })
  if (result.error != null) {
    try {
      rmSync(temporaryOutput)
    } catch {}
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(
        [
          `matc timed out after ${options.matcTimeoutMs}ms before compiling ${formatRelative(options.material)}.`,
          `matc: ${matcPath}`,
          'Run compile-spz-material --diagnose-matc to inspect architecture, xattrs, codesign, spctl, and launch behavior.',
          'If --diagnose-matc also times out on matc --help, the host tool cannot launch in this environment; compile the material in CI or on a machine where matc starts successfully.',
        ].join('\n'),
      )
    }
    throw result.error
  }
  if (result.status !== 0) {
    try {
      rmSync(temporaryOutput)
    } catch {}
    throw new Error(`matc failed with exit code ${result.status}`)
  }

  renameSync(temporaryOutput, options.output)
  console.log(`Compiled ${formatRelative(options.material)} -> ${formatRelative(options.output)}`)
}

function runDiagnosticCommand(label, command, args, timeoutMs = 5000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  const stdout = result.stdout?.trim()
  const stderr = result.stderr?.trim()
  const status = result.status ?? (result.signal ? `signal ${result.signal}` : 'unknown')
  const timedOut = result.error?.code === 'ETIMEDOUT'

  console.log(`\n[${label}] ${command} ${args.join(' ')}`)
  if (timedOut) {
    console.log(`timed out after ${timeoutMs}ms`)
    return
  }
  if (result.error != null) {
    console.log(result.error.message)
    return
  }
  console.log(`status: ${status}`)
  if (stdout) console.log(stdout)
  if (stderr) console.log(stderr)
}

function diagnoseMatc(matcPath, options) {
  console.log(`matc: ${matcPath}`)
  try {
    const stat = statSync(matcPath)
    console.log(`size: ${stat.size}`)
    console.log(`modified: ${formatDate(stat.mtimeMs)}`)
  } catch (error) {
    console.log(`stat failed: ${error instanceof Error ? error.message : error}`)
  }

  runDiagnosticCommand('file', 'file', [matcPath])
  if (process.platform === 'darwin') {
    runDiagnosticCommand('xattr', 'xattr', ['-lr', matcPath])
    runDiagnosticCommand('codesign', 'codesign', ['--verify', '--verbose=4', matcPath])
    runDiagnosticCommand('spctl', 'spctl', ['--assess', '--type', 'execute', '-vv', matcPath])
  }
  runDiagnosticCommand('matc launch', matcPath, ['--help'], Math.min(options.matcTimeoutMs, 5000))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  if (options.check) {
    checkMaterialFreshness(options)
    return
  }

  let matcPath =
    (options.downloadTools || options.downloadMavenMatc) && options.filamentVersion !== 'latest' && options.matc == null
      ? undefined
      : findLocalMatc(options.matc)
  if (!matcPath && options.downloadMavenMatc) {
    matcPath = await downloadMavenMatc(options.filamentVersion)
  }
  if (!matcPath && options.downloadTools) {
    matcPath = await downloadMatc(options.filamentVersion)
  }

  if (!matcPath) {
    throw new Error(
      'Could not find Filament matc. Set MATC=/path/to/matc, pass --matc, build ./filament, or rerun with --download-tools.',
    )
  }

  if (options.diagnoseMatc) {
    diagnoseMatc(matcPath, options)
    return
  }

  runMatc(matcPath, options)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
