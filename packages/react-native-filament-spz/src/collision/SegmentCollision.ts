export type CollisionSegment = readonly [number, number, number, number]

export type CollisionDebugBox = {
  readonly id: string
  readonly position: readonly [number, number, number]
  readonly halfExtent: readonly [number, number, number]
}

export type SegmentCollisionResult = [x: number, z: number, hit: number]

export const DEFAULT_SEGMENT_COLLISION_SKIN = 0.006
export const DEFAULT_SEGMENT_COLLISION_ITERATIONS = 4
export const DEFAULT_SEGMENT_COLLISION_MAX_SUBSTEP = 0.035

function clamp(value: number, min: number, max: number) {
  'worklet'
  return Math.max(min, Math.min(max, value))
}

export function pushOutOfSegmentCollision(
  inputX: number,
  inputZ: number,
  segments: readonly CollisionSegment[],
  radius: number,
  skin = DEFAULT_SEGMENT_COLLISION_SKIN,
  iterations = DEFAULT_SEGMENT_COLLISION_ITERATIONS
): SegmentCollisionResult {
  'worklet'
  let x = inputX
  let z = inputZ
  let hit = 0
  const expandedRadius = radius + skin
  const radiusSq = expandedRadius * expandedRadius

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let moved = 0
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]
      const x1 = segment[0]
      const z1 = segment[1]
      const x2 = segment[2]
      const z2 = segment[3]
      const sx = x2 - x1
      const sz = z2 - z1
      const lengthSq = sx * sx + sz * sz
      if (lengthSq <= 0.000001) continue

      const t = clamp(((x - x1) * sx + (z - z1) * sz) / lengthSq, 0, 1)
      const closestX = x1 + sx * t
      const closestZ = z1 + sz * t
      let dx = x - closestX
      let dz = z - closestZ
      let distanceSq = dx * dx + dz * dz
      if (distanceSq >= radiusSq) continue

      if (distanceSq <= 0.000001) {
        const length = Math.sqrt(lengthSq)
        dx = -sz / length
        dz = sx / length
        const side = (x - x1) * dx + (z - z1) * dz
        if (side < 0) {
          dx = -dx
          dz = -dz
        }
        distanceSq = 1
      }

      const distance = Math.sqrt(distanceSq)
      const push = expandedRadius - distance
      x += (dx / distance) * push
      z += (dz / distance) * push
      moved = 1
      hit = 1
    }
    if (moved === 0) break
  }

  return [x, z, hit]
}

export function resolveSegmentCollisionMove(
  currentX: number,
  currentZ: number,
  nextX: number,
  nextZ: number,
  segments: readonly CollisionSegment[],
  radius: number,
  skin = DEFAULT_SEGMENT_COLLISION_SKIN,
  iterations = DEFAULT_SEGMENT_COLLISION_ITERATIONS,
  maxSubstep = DEFAULT_SEGMENT_COLLISION_MAX_SUBSTEP
): SegmentCollisionResult {
  'worklet'
  const deltaX = nextX - currentX
  const deltaZ = nextZ - currentZ
  const distance = Math.hypot(deltaX, deltaZ)
  const steps = Math.max(1, Math.ceil(distance / maxSubstep))
  const stepX = deltaX / steps
  const stepZ = deltaZ / steps
  let resolvedX = currentX
  let resolvedZ = currentZ
  let hit = 0

  for (let i = 0; i < steps; i += 1) {
    resolvedX += stepX
    resolvedZ += stepZ
    const pushed = pushOutOfSegmentCollision(resolvedX, resolvedZ, segments, radius, skin, iterations)
    resolvedX = pushed[0]
    resolvedZ = pushed[1]
    if (pushed[2] === 1) hit = 1
  }

  return [resolvedX, resolvedZ, hit]
}
