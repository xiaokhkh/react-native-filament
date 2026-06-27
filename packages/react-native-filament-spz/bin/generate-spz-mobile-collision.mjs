#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

const FLOOR_CULL_HEIGHT = 0.22
const FLOOR_NORMAL_Y = 0.42
const LOW_DEBRIS_HEIGHT = 0.18
const VERTICAL_NORMAL_Y = 0.35
const DEFAULT_CHARACTER_COLLISION_MIN_Y = 0.18
const DEFAULT_CHARACTER_COLLISION_MAX_Y = 1.65
const MIN_SEGMENT_LENGTH = 0.045
const MERGE_GAP = 0.035
const DEFAULT_DEBUG_BOX_LIMIT = 420
const DEFAULT_DEBUG_BOX_HEIGHT = 1.6
const DEFAULT_DEBUG_BOX_THICKNESS = 0.06

let characterCollisionMinY = DEFAULT_CHARACTER_COLLISION_MIN_Y
let characterCollisionMaxY = DEFAULT_CHARACTER_COLLISION_MAX_Y
let debugBoxLimit = DEFAULT_DEBUG_BOX_LIMIT
let debugBoxHeight = DEFAULT_DEBUG_BOX_HEIGHT
let debugBoxThickness = DEFAULT_DEBUG_BOX_THICKNESS

function valueAfter(args, name, fallback) {
  const index = args.indexOf(name)
  if (index === -1 || index === args.length - 1) return fallback
  return args[index + 1]
}

function hasFlag(args, name) {
  return args.includes(name)
}

function parseNumber(value, label) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a finite number`)
  }
  return parsed
}

function parseCsvNumbers(value, expected, label) {
  const parts = String(value).split(',').map((part) => Number(part.trim()))
  if (parts.length !== expected || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`${label} must contain ${expected} comma-separated numbers`)
  }
  return parts
}

function assertIdentifier(value, label) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`${label} must be a valid JavaScript identifier`)
  }
  return value
}

function printHelp() {
  console.log(`Usage: generate-spz-mobile-collision [options]

Reads an @playcanvas/splat-transform .collision.glb and its collision report,
then writes mobile-friendly 2D collision segments and debug boxes as TypeScript.

Options:
  --collision-glb <path>        Required input .collision.glb.
  --report <path>               Required collision report JSON from generate-spz-collision.
  --output <path>               Output TypeScript file. Default: ./spzCollision.ts.
  --export-name <identifier>    Exported constant name. Default: SPZ_COLLISION.
  --collision-y-range <min,max> Character body Y range kept for 2D collision. Default: ${DEFAULT_CHARACTER_COLLISION_MIN_Y},${DEFAULT_CHARACTER_COLLISION_MAX_Y}.
  --debug-box-limit <count>     Maximum debug boxes to emit. Default: ${DEFAULT_DEBUG_BOX_LIMIT}.
  --debug-box-height <meters>   Debug box height. Default: ${DEFAULT_DEBUG_BOX_HEIGHT}.
  --debug-box-thickness <m>     Debug box minimum X/Z thickness. Default: ${DEFAULT_DEBUG_BOX_THICKNESS}.
  --help                        Show this help.
`)
}

function round(value, digits = 3) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function formatNumber(value) {
  const rounded = round(value)
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

function formatVec(values) {
  return `[${values.map(formatNumber).join(', ')}]`
}

function repoRelativePath(repoRoot, filePath) {
  return relative(repoRoot, filePath).split(sep).join('/')
}

function resolveRepoPath(repoRoot, filePath) {
  return isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath)
}

function rawToWorld(point, semantics) {
  const scale = semantics.metricScaleFactor
  const yOffset = semantics.groundPlaneOffset
  if (semantics.flipY) {
    return [point[0] * scale, -point[1] * scale + yOffset, -point[2] * scale]
  }
  return [point[0] * scale, point[1] * scale + yOffset, point[2] * scale]
}

function triangleNormal(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  const normal = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ]
  const length = Math.hypot(normal[0], normal[1], normal[2])
  if (length <= 0.000001) return [0, 0, 0]
  return [normal[0] / length, normal[1] / length, normal[2] / length]
}

function distSq2(a, b) {
  const dx = a[0] - b[0]
  const dz = a[2] - b[2]
  return dx * dx + dz * dz
}

function segmentFromTriangle(a, b, c) {
  const pairs = [
    [a, b, distSq2(a, b)],
    [b, c, distSq2(b, c)],
    [c, a, distSq2(c, a)],
  ].sort((left, right) => right[2] - left[2])

  const [from, to, lengthSq] = pairs[0]
  if (lengthSq < MIN_SEGMENT_LENGTH * MIN_SEGMENT_LENGTH) return undefined
  return [from[0], from[2], to[0], to[2]]
}

function canonicalSegment(segment) {
  let [x1, z1, x2, z2] = segment
  if (x2 < x1 || (x2 === x1 && z2 < z1)) {
    ;[x1, z1, x2, z2] = [x2, z2, x1, z1]
  }
  return [round(x1), round(z1), round(x2), round(z2)]
}

function mergeAxisSegments(segments) {
  const xGroups = new Map()
  const zGroups = new Map()
  const diagonals = []

  for (const segment of segments) {
    const [x1, z1, x2, z2] = canonicalSegment(segment)
    if (Math.hypot(x2 - x1, z2 - z1) < MIN_SEGMENT_LENGTH) continue

    if (Math.abs(x1 - x2) <= 0.006) {
      const x = round((x1 + x2) / 2)
      const key = formatNumber(x)
      const range = [Math.min(z1, z2), Math.max(z1, z2)]
      const group = xGroups.get(key) ?? []
      group.push(range)
      xGroups.set(key, group)
    } else if (Math.abs(z1 - z2) <= 0.006) {
      const z = round((z1 + z2) / 2)
      const key = formatNumber(z)
      const range = [Math.min(x1, x2), Math.max(x1, x2)]
      const group = zGroups.get(key) ?? []
      group.push(range)
      zGroups.set(key, group)
    } else {
      diagonals.push([x1, z1, x2, z2])
    }
  }

  const merged = []
  for (const [key, ranges] of xGroups) {
    const x = Number(key)
    ranges.sort((left, right) => left[0] - right[0])
    let current = ranges[0]
    for (let i = 1; i < ranges.length; i += 1) {
      const next = ranges[i]
      if (next[0] <= current[1] + MERGE_GAP) {
        current[1] = Math.max(current[1], next[1])
      } else {
        if (current[1] - current[0] >= MIN_SEGMENT_LENGTH) merged.push([x, round(current[0]), x, round(current[1])])
        current = next
      }
    }
    if (current && current[1] - current[0] >= MIN_SEGMENT_LENGTH) merged.push([x, round(current[0]), x, round(current[1])])
  }

  for (const [key, ranges] of zGroups) {
    const z = Number(key)
    ranges.sort((left, right) => left[0] - right[0])
    let current = ranges[0]
    for (let i = 1; i < ranges.length; i += 1) {
      const next = ranges[i]
      if (next[0] <= current[1] + MERGE_GAP) {
        current[1] = Math.max(current[1], next[1])
      } else {
        if (current[1] - current[0] >= MIN_SEGMENT_LENGTH) merged.push([round(current[0]), z, round(current[1]), z])
        current = next
      }
    }
    if (current && current[1] - current[0] >= MIN_SEGMENT_LENGTH) merged.push([round(current[0]), z, round(current[1]), z])
  }

  const unique = new Map()
  for (const segment of [...merged, ...diagonals]) {
    const canonical = canonicalSegment(segment)
    unique.set(canonical.join(','), canonical)
  }
  return [...unique.values()].sort((left, right) => {
    const leftLength = Math.hypot(left[2] - left[0], left[3] - left[1])
    const rightLength = Math.hypot(right[2] - right[0], right[3] - right[1])
    return rightLength - leftLength
  })
}

function addBoundsSegments(segments, bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 6) return
  const [minX, _minY, minZ, maxX, _maxY, maxZ] = bounds
  segments.push([minX, minZ, maxX, minZ])
  segments.push([maxX, minZ, maxX, maxZ])
  segments.push([maxX, maxZ, minX, maxZ])
  segments.push([minX, maxZ, minX, minZ])
}

function debugBoxesFromSegments(segments) {
  return segments
    .map((segment, index) => {
      const [x1, z1, x2, z2] = segment
      const length = Math.hypot(x2 - x1, z2 - z1)
      const axisAligned = Math.abs(x1 - x2) <= 0.006 || Math.abs(z1 - z2) <= 0.006
      if (!axisAligned || length < MIN_SEGMENT_LENGTH) return undefined

      return {
        id: `generated-${index}`,
        length,
        position: [round((x1 + x2) / 2), round(debugBoxHeight / 2), round((z1 + z2) / 2)],
        halfExtent: [
          round(Math.max(Math.abs(x2 - x1) / 2, debugBoxThickness)),
          round(debugBoxHeight / 2),
          round(Math.max(Math.abs(z2 - z1) / 2, debugBoxThickness)),
        ],
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .slice(0, debugBoxLimit)
    .map(({ id, position, halfExtent }) => ({ id, position, halfExtent }))
}

async function extractSegments(collisionGlb, semantics) {
  const data = readFileSync(collisionGlb)
  const loader = new GLTFLoader()
  const gltf = await loader.parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '')
  gltf.scene.updateMatrixWorld(true)

  const segments = []
  let meshes = 0
  let triangles = 0
  let keptTriangles = 0

  const localA = new THREE.Vector3()
  const localB = new THREE.Vector3()
  const localC = new THREE.Vector3()

  gltf.scene.traverse((object) => {
    if (!object.isMesh) return
    meshes += 1
    object.updateWorldMatrix(true, false)
    const geometry = object.geometry
    const position = geometry.getAttribute('position')
    if (!position) return

    const index = geometry.index
    const count = index ? index.count : position.count
    triangles += count / 3

    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i
      const ib = index ? index.getX(i + 1) : i + 1
      const ic = index ? index.getX(i + 2) : i + 2

      localA.fromBufferAttribute(position, ia).applyMatrix4(object.matrixWorld)
      localB.fromBufferAttribute(position, ib).applyMatrix4(object.matrixWorld)
      localC.fromBufferAttribute(position, ic).applyMatrix4(object.matrixWorld)

      const a = rawToWorld([localA.x, localA.y, localA.z], semantics)
      const b = rawToWorld([localB.x, localB.y, localB.z], semantics)
      const c = rawToWorld([localC.x, localC.y, localC.z], semantics)
      const normal = triangleNormal(a, b, c)
      const centerY = (a[1] + b[1] + c[1]) / 3
      const minY = Math.min(a[1], b[1], c[1])
      const maxY = Math.max(a[1], b[1], c[1])
      const lowWalkSurface = centerY < FLOOR_CULL_HEIGHT && normal[1] > FLOOR_NORMAL_Y
      const lowDebris = maxY < LOW_DEBRIS_HEIGHT
      const outsideCharacterHeight = maxY < characterCollisionMinY || minY > characterCollisionMaxY
      if (lowWalkSurface || lowDebris || outsideCharacterHeight || Math.abs(normal[1]) > VERTICAL_NORMAL_Y) continue

      const segment = segmentFromTriangle(a, b, c)
      if (!segment) continue
      keptTriangles += 1
      segments.push(segment)
    }
  })

  return {
    meshes,
    triangles,
    keptTriangles,
    segments,
  }
}

function writeTypescript(output, payload, exportName) {
  const lines = [
    '/* eslint-disable */',
    '// Generated by react-native-filament-spz/bin/generate-spz-mobile-collision.mjs.',
    '// Source data comes from an @playcanvas/splat-transform .collision.glb.',
    '',
    "import type { CollisionDebugBox, CollisionSegment } from 'react-native-filament-spz'",
    '',
    `export const ${exportName} = {`,
    `  source: ${JSON.stringify(payload.source)},`,
    `  collisionGlb: ${JSON.stringify(payload.collisionGlb)},`,
    `  generatedAt: ${JSON.stringify(payload.generatedAt)},`,
    '  semantics: {',
    `    metricScaleFactor: ${formatNumber(payload.semantics.metricScaleFactor)},`,
    `    groundPlaneOffset: ${formatNumber(payload.semantics.groundPlaneOffset)},`,
    `    flipY: ${payload.semantics.flipY ? 'true' : 'false'},`,
    '  },',
    '  bounds: {',
    `    minX: ${formatNumber(payload.bounds.minX)},`,
    `    maxX: ${formatNumber(payload.bounds.maxX)},`,
    `    minZ: ${formatNumber(payload.bounds.minZ)},`,
    `    maxZ: ${formatNumber(payload.bounds.maxZ)},`,
    '  },',
    '  stats: {',
    `    meshes: ${payload.stats.meshes},`,
    `    triangles: ${Math.round(payload.stats.triangles)},`,
    `    keptTriangles: ${payload.stats.keptTriangles},`,
    `    rawSegments: ${payload.stats.rawSegments},`,
    `    mergedSegments: ${payload.stats.mergedSegments},`,
    `    debugBoxes: ${payload.stats.debugBoxes},`,
    '  },',
    '  segments: [',
    ...payload.segments.map((segment) => `    ${formatVec(segment)},`),
    '  ] as readonly CollisionSegment[],',
    '  debugBoxes: [',
    ...payload.debugBoxes.map((box) => `    { id: ${JSON.stringify(box.id)}, position: ${formatVec(box.position)}, halfExtent: ${formatVec(box.halfExtent)} },`),
    '  ] as readonly CollisionDebugBox[],',
    '} as const',
    '',
  ]

  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, lines.join('\n'))
}

const args = process.argv.slice(2)
if (hasFlag(args, '--help')) {
  printHelp()
  process.exit(0)
}
const repoRoot = resolve(new URL('../../..', import.meta.url).pathname)
const collisionGlbInput = valueAfter(args, '--collision-glb')
const reportInput = valueAfter(args, '--report')
if (collisionGlbInput == null || reportInput == null) {
  printHelp()
  throw new Error('--collision-glb and --report are required')
}
const defaultOutput = resolve(process.cwd(), 'spzCollision.ts')
const collisionGlb = resolve(collisionGlbInput)
const reportPath = resolve(reportInput)
const output = resolve(valueAfter(args, '--output', defaultOutput))
const exportName = assertIdentifier(valueAfter(args, '--export-name', 'SPZ_COLLISION'), '--export-name')
const yRange = parseCsvNumbers(
  valueAfter(args, '--collision-y-range', `${DEFAULT_CHARACTER_COLLISION_MIN_Y},${DEFAULT_CHARACTER_COLLISION_MAX_Y}`),
  2,
  '--collision-y-range'
)
characterCollisionMinY = yRange[0]
characterCollisionMaxY = yRange[1]
debugBoxLimit = Math.max(0, Math.floor(parseNumber(valueAfter(args, '--debug-box-limit', DEFAULT_DEBUG_BOX_LIMIT), '--debug-box-limit')))
debugBoxHeight = parseNumber(valueAfter(args, '--debug-box-height', DEFAULT_DEBUG_BOX_HEIGHT), '--debug-box-height')
debugBoxThickness = parseNumber(valueAfter(args, '--debug-box-thickness', DEFAULT_DEBUG_BOX_THICKNESS), '--debug-box-thickness')
const report = JSON.parse(readFileSync(reportPath, 'utf-8'))
const semantics = report.semantics ?? {
  metricScaleFactor: 1,
  groundPlaneOffset: 0,
  flipY: true,
}

const extracted = await extractSegments(collisionGlb, semantics)
const rawSegments = [...extracted.segments]
addBoundsSegments(rawSegments, report.targetWorldBounds)
const segments = mergeAxisSegments(rawSegments)
const debugBoxes = debugBoxesFromSegments(segments)
const [minX, _minY, minZ, maxX, _maxY, maxZ] = report.targetWorldBounds

const payload = {
  source: repoRelativePath(repoRoot, resolveRepoPath(repoRoot, report.source)),
  collisionGlb: repoRelativePath(repoRoot, collisionGlb),
  generatedAt: new Date().toISOString(),
  semantics,
  bounds: { minX, maxX, minZ, maxZ },
  stats: {
    meshes: extracted.meshes,
    triangles: extracted.triangles,
    keptTriangles: extracted.keptTriangles,
    rawSegments: rawSegments.length,
    mergedSegments: segments.length,
    debugBoxes: debugBoxes.length,
  },
  segments,
  debugBoxes,
}

writeTypescript(output, payload, exportName)

console.log(`mobile collision source: ${collisionGlb}`)
console.log(`output: ${output}`)
console.log(`triangles: ${Math.round(extracted.triangles)}`)
console.log(`kept vertical triangles: ${extracted.keptTriangles}`)
console.log(`segments: ${rawSegments.length} raw -> ${segments.length} merged`)
console.log(`debug boxes: ${debugBoxes.length}`)
