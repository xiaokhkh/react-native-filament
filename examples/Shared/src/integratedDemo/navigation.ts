import type { Float3 } from 'react-native-filament'

export type Vec2 = [number, number]
export type Vec3 = Float3

export type Viewport = {
  width: number
  height: number
}

export type Bounds = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

export type Obstacle = Bounds & {
  id: string
}

export type WalkNavigation = {
  startPosition: Vec3
  startYaw: number
  bounds: Bounds
  characterRadius: number
  arrivalRadius: number
  obstacles: Obstacle[]
}

export type CameraPose = {
  position: Vec3
  target: Vec3
  up: Vec3
  fovDegrees: number
  near: number
  far: number
}

export const APARTMENT_CAMERA: CameraPose = {
  position: [0.12, 2.52, 5.9],
  target: [0.02, 0.72, -0.78],
  up: [0, 1, 0],
  fovDegrees: 43,
  near: 0.1,
  far: 30,
}

export const APARTMENT_NAVIGATION: WalkNavigation = {
  startPosition: [0.08, 0, 0.74],
  startYaw: 0,
  bounds: {
    minX: -3.85,
    maxX: 3.75,
    minZ: -2.35,
    maxZ: 1.95,
  },
  characterRadius: 0.22,
  arrivalRadius: 0.08,
  obstacles: [],
}

export const SPZ_WORLD = {
  metricScaleFactor: 2.1183093,
  groundPlaneOffset: 2.053388,
  flipY: true,
}

export const SPZ_RENDERING = {
  splatScale: 1.0,
}

export const SPZ_NAVIGATION: WalkNavigation = {
  startPosition: [0.2, 0, -10.1],
  startYaw: Math.PI,
  bounds: {
    minX: -5.7,
    maxX: 5.9,
    minZ: -16.2,
    maxZ: -4.2,
  },
  characterRadius: 0.24,
  arrivalRadius: 0.12,
  obstacles: [],
}

export const SPZ_FREE_CAMERA = {
  position: [0.2, 1.63, -9.05] as Vec3,
  target: [0.2, 1.55, -10.05] as Vec3,
  fovDegrees: 75,
  near: 0.02,
  far: 80,
}

export const SPZ_FOLLOW_CAMERA = {
  distance: 2.15,
  height: 1.58,
  targetHeight: 0.82,
  fovDegrees: 72,
  near: 0.02,
  far: 80,
}

export function clamp(value: number, min: number, max: number) {
  'worklet'
  return Math.max(min, Math.min(max, value))
}

export function normalize3(value: Vec3): Vec3 {
  'worklet'
  const length = Math.hypot(value[0], value[1], value[2])
  if (length <= 0.000001) return [0, 0, 0]
  return [value[0] / length, value[1] / length, value[2] / length]
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  'worklet'
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export function dot3(a: Vec3, b: Vec3) {
  'worklet'
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

export function resolveWalkablePoint(navigation: WalkNavigation, position: Vec3, radius = navigation.characterRadius): Vec3 {
  'worklet'
  let x = clamp(position[0], navigation.bounds.minX, navigation.bounds.maxX)
  let z = clamp(position[2], navigation.bounds.minZ, navigation.bounds.maxZ)

  for (const obstacle of navigation.obstacles) {
    const minX = obstacle.minX - radius
    const maxX = obstacle.maxX + radius
    const minZ = obstacle.minZ - radius
    const maxZ = obstacle.maxZ + radius

    if (x < minX || x > maxX || z < minZ || z > maxZ) {
      continue
    }

    const left = Math.abs(x - minX)
    const right = Math.abs(maxX - x)
    const top = Math.abs(z - minZ)
    const bottom = Math.abs(maxZ - z)
    const nearest = Math.min(left, right, top, bottom)

    if (nearest === left) x = minX
    else if (nearest === right) x = maxX
    else if (nearest === top) z = minZ
    else z = maxZ
  }

  return [clamp(x, navigation.bounds.minX, navigation.bounds.maxX), 0, clamp(z, navigation.bounds.minZ, navigation.bounds.maxZ)]
}

export function screenPointToGround(screenX: number, screenY: number, viewport: Viewport, camera: CameraPose, groundY = 0): Vec3 {
  if (viewport.width <= 0 || viewport.height <= 0) {
    return [camera.target[0], groundY, camera.target[2]]
  }

  const ndcX = (screenX / viewport.width) * 2 - 1
  const ndcY = 1 - (screenY / viewport.height) * 2
  const aspect = viewport.width / viewport.height
  const forward = normalize3([
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ])
  const right = normalize3(cross3(forward, camera.up))
  const cameraUp = normalize3(cross3(right, forward))
  const tanHalfFov = Math.tan((camera.fovDegrees * Math.PI) / 360)
  const rayDirection = normalize3([
    forward[0] + right[0] * ndcX * tanHalfFov * aspect + cameraUp[0] * ndcY * tanHalfFov,
    forward[1] + right[1] * ndcX * tanHalfFov * aspect + cameraUp[1] * ndcY * tanHalfFov,
    forward[2] + right[2] * ndcX * tanHalfFov * aspect + cameraUp[2] * ndcY * tanHalfFov,
  ])

  if (Math.abs(rayDirection[1]) <= 0.0001) {
    return [camera.target[0], groundY, camera.target[2]]
  }

  const t = (groundY - camera.position[1]) / rayDirection[1]
  if (t <= 0) {
    return [camera.target[0], groundY, camera.target[2]]
  }

  return [
    camera.position[0] + rayDirection[0] * t,
    groundY,
    camera.position[2] + rayDirection[2] * t,
  ]
}

export function getFollowCameraPose(position: Vec3, yaw: number): CameraPose {
  'worklet'
  const forward: Vec3 = [Math.sin(yaw), 0, Math.cos(yaw)]
  return {
    position: [
      position[0] - forward[0] * SPZ_FOLLOW_CAMERA.distance,
      SPZ_FOLLOW_CAMERA.height,
      position[2] - forward[2] * SPZ_FOLLOW_CAMERA.distance,
    ],
    target: [position[0], SPZ_FOLLOW_CAMERA.targetHeight, position[2]],
    up: [0, 1, 0],
    fovDegrees: SPZ_FOLLOW_CAMERA.fovDegrees,
    near: SPZ_FOLLOW_CAMERA.near,
    far: SPZ_FOLLOW_CAMERA.far,
  }
}

export function screenPointToApartmentFloor(screenX: number, screenY: number, viewport: Viewport): Vec3 {
  return resolveWalkablePoint(APARTMENT_NAVIGATION, screenPointToGround(screenX, screenY, viewport, APARTMENT_CAMERA))
}

export function screenPointToSpzFloor(screenX: number, screenY: number, viewport: Viewport, position: Vec3, yaw: number): Vec3 {
  return resolveWalkablePoint(SPZ_NAVIGATION, screenPointToGround(screenX, screenY, viewport, getFollowCameraPose(position, yaw)))
}
