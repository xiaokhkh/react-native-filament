import React, { useCallback, useMemo, useState } from 'react'
import { StatusBar, StyleSheet, Text, View } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useSharedValue as useAnimatedSharedValue,
  type SharedValue as ReanimatedSharedValue,
} from 'react-native-reanimated'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import {
  EnvironmentalLight,
  FilamentScene,
  FilamentView,
  Light,
  Model,
  useEntityInScene,
  useFilamentContext,
  useGaussianSplat,
  useSyncSharedValue,
  useWorkletMemo,
  type AmbientOcclusionOptions,
  type BloomOptions,
  type Float3,
  type RenderCallback,
  type TemporalAntiAliasingOptions,
} from 'react-native-filament'
import {
  DEFAULT_SEGMENT_COLLISION_ITERATIONS,
  DEFAULT_SEGMENT_COLLISION_MAX_SUBSTEP,
  DEFAULT_SEGMENT_COLLISION_SKIN,
  resolveSegmentCollisionMove,
  type CollisionDebugBox as GeneratedCollisionDebugBox,
  type CollisionPolygon,
} from 'react-native-filament-spz'
import {
  useRunOnJS,
  useSharedValue as useWorkletsSharedValue,
  type ISharedValue,
} from 'react-native-worklets-core'
import WorldSpz from '@assets/1-world-500k.spz'
import TargetRingModel from '@assets/target-ring.glb'
import { cross3, normalize3, SPZ_NAVIGATION, SPZ_RENDERING, SPZ_WORLD, type CameraPose, type Vec3 } from './navigation'
import { MovementModeValue, type MovementState } from './useTapMoveControls'
import { WalkCharacter } from './WalkCharacter'
import { SPZ_COLLISION } from '../generated/beloSpzCollision'

const MOVE_SPEED_METERS_PER_SECOND = 2.25
const MAX_FRAME_STEP = 1 / 20
const SORT_INTERVAL_SECONDS = 0.08
const CHARACTER_SCALE: Float3 = [1.12, 1.12, 1.12]
const CHARACTER_Y_OFFSET = 0.04
const HOME_CAMERA_YAW = 0
const DEFAULT_CAMERA_PITCH = -0.06
const MIN_CAMERA_PITCH = -0.38
const MAX_CAMERA_PITCH = 0.32
const LOOK_SPEED = 0.0032
const MOVE_DEAD_ZONE = 0.08
const TAP_MOVE_MAX_DISTANCE = 11
const JOYSTICK_RADIUS = 64
const JOYSTICK_SIZE = JOYSTICK_RADIUS * 2
const JOYSTICK_KNOB_SIZE = 42
const JOYSTICK_MARGIN = 24
const THIRD_PERSON_DISTANCE = 3.05
const THIRD_PERSON_CAMERA_HEIGHT = 1.62
const THIRD_PERSON_TARGET_HEIGHT = 0.86
const THIRD_PERSON_TARGET_FORWARD = 0.22
const THIRD_PERSON_FOV = 66
const THIRD_PERSON_NEAR = 0.02
const THIRD_PERSON_FAR = 80
const PLAYER_COLLISION_RADIUS = 0.26
const CAMERA_COLLISION_RADIUS = 0.12
const COLLISION_STEP_METERS = 0.04
const COLLISION_SEGMENTS = SPZ_COLLISION.segments
const COLLISION_DEBUG_BOXES = SPZ_COLLISION.debugBoxes
const WALKABLE_POLYGONS = SPZ_COLLISION.walkable.polygons
const WALKABLE_BOUNDS = SPZ_COLLISION.walkable.bounds
const COLLISION_SKIN = DEFAULT_SEGMENT_COLLISION_SKIN
const COLLISION_ITERATIONS = DEFAULT_SEGMENT_COLLISION_ITERATIONS
const MAX_COLLISION_SUBSTEP = DEFAULT_SEGMENT_COLLISION_MAX_SUBSTEP
const CHARACTER_KEY_LIGHT_INTENSITY = 68000
const CHARACTER_SPOT_LIGHT_INTENSITY = 46000
const CHARACTER_WARM_FILL_INTENSITY = 9000
const CHARACTER_COOL_RIM_INTENSITY = 7000

const CHARACTER_AMBIENT_OCCLUSION_OPTIONS = {
  enabled: true,
  radius: 0.18,
  power: 0.58,
  bias: 0.008,
  resolution: 0.5,
  intensity: 0.36,
  bilateralThreshold: 0.04,
  quality: 'MEDIUM',
  lowPassFilter: 'MEDIUM',
  upsampling: 'MEDIUM',
} satisfies AmbientOcclusionOptions

const CHARACTER_BLOOM_OPTIONS = {
  enabled: false,
  strength: 0,
  resolution: 360,
  levels: 4,
  blendMode: 'INTERPOLATE',
  threshold: false,
  quality: 'MEDIUM',
  lensFlare: false,
  starburst: false,
  chromaticAberration: 0,
} satisfies BloomOptions

const CHARACTER_TEMPORAL_AA_OPTIONS = {
  enabled: true,
  feedback: 0.11,
  lodBias: -0.7,
  sharpness: 0.18,
  boxClipping: 'ACCURATE',
  jitterPattern: 'HALTON_23_X8',
  filterHistory: true,
  filterInput: true,
  preventFlickering: true,
} satisfies TemporalAntiAliasingOptions

function clampInput(value: number, min: number, max: number) {
  'worklet'
  return Math.max(min, Math.min(max, value))
}

function getFlatForward(yaw: number): Vec3 {
  'worklet'
  return normalize3([Math.sin(yaw), 0, -Math.cos(yaw)])
}

function getRight(yaw: number): Vec3 {
  'worklet'
  return [Math.cos(yaw), 0, Math.sin(yaw)]
}

function getCameraBasis(eye: Vec3, target: Vec3) {
  'worklet'
  const forward = normalize3([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]])
  const right = normalize3(cross3(forward, [0, 1, 0]))
  const cameraUp = normalize3(cross3(right, forward))
  return { forward, right, cameraUp }
}

function getThirdPersonCameraPose(position: Vec3, yaw: number, pitch: number): CameraPose {
  'worklet'
  const forward = getFlatForward(yaw)
  const target: Vec3 = [
    position[0] + forward[0] * THIRD_PERSON_TARGET_FORWARD,
    THIRD_PERSON_TARGET_HEIGHT + pitch * 1.35,
    position[2] + forward[2] * THIRD_PERSON_TARGET_FORWARD,
  ]

  return {
    position: [
      position[0] - forward[0] * THIRD_PERSON_DISTANCE,
      THIRD_PERSON_CAMERA_HEIGHT,
      position[2] - forward[2] * THIRD_PERSON_DISTANCE,
    ],
    target,
    up: [0, 1, 0],
    fovDegrees: THIRD_PERSON_FOV,
    near: THIRD_PERSON_NEAR,
    far: THIRD_PERSON_FAR,
  }
}

function pointInGeneratedPolygon(x: number, z: number, polygon: CollisionPolygon) {
  'worklet'
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0]
    const zi = polygon[i][1]
    const xj = polygon[j][0]
    const zj = polygon[j][1]
    const intersects = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 0.0000001) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function isPointInGeneratedWalkable(x: number, z: number) {
  'worklet'
  if (x < WALKABLE_BOUNDS.minX || x > WALKABLE_BOUNDS.maxX || z < WALKABLE_BOUNDS.minZ || z > WALKABLE_BOUNDS.maxZ) {
    return false
  }

  for (let i = 0; i < WALKABLE_POLYGONS.length; i += 1) {
    if (pointInGeneratedPolygon(x, z, WALKABLE_POLYGONS[i])) {
      return true
    }
  }
  return false
}

function isGeneratedWalkablePointSafe(x: number, z: number, radius: number) {
  'worklet'
  if (!isPointInGeneratedWalkable(x, z)) {
    return false
  }

  const sampleRadius = radius * 0.45
  if (sampleRadius <= 0.0001) return true
  return (
    isPointInGeneratedWalkable(x + sampleRadius, z) &&
    isPointInGeneratedWalkable(x - sampleRadius, z) &&
    isPointInGeneratedWalkable(x, z + sampleRadius) &&
    isPointInGeneratedWalkable(x, z - sampleRadius)
  )
}

function closestPointOnGeneratedSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): [number, number, number] {
  'worklet'
  const dx = bx - ax
  const dz = bz - az
  const lengthSq = dx * dx + dz * dz
  if (lengthSq <= 0.000001) {
    const distanceSq = (x - ax) * (x - ax) + (z - az) * (z - az)
    return [ax, az, distanceSq]
  }

  const t = clampInput(((x - ax) * dx + (z - az) * dz) / lengthSq, 0, 1)
  const px = ax + dx * t
  const pz = az + dz * t
  const distanceSq = (x - px) * (x - px) + (z - pz) * (z - pz)
  return [px, pz, distanceSq]
}

function closestPointOnGeneratedPolygon(x: number, z: number, polygon: CollisionPolygon): [number, number, number] {
  'worklet'
  if (pointInGeneratedPolygon(x, z, polygon)) return [x, z, 0]

  let bestX = polygon[0][0]
  let bestZ = polygon[0][1]
  let bestDistanceSq = Number.POSITIVE_INFINITY
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const closest = closestPointOnGeneratedSegment(x, z, polygon[j][0], polygon[j][1], polygon[i][0], polygon[i][1])
    if (closest[2] < bestDistanceSq) {
      bestX = closest[0]
      bestZ = closest[1]
      bestDistanceSq = closest[2]
    }
  }
  return [bestX, bestZ, bestDistanceSq]
}

function projectToNearestGeneratedWalkablePoint(x: number, z: number, radius: number): [number, number] {
  'worklet'
  const clampedX = clampInput(x, WALKABLE_BOUNDS.minX, WALKABLE_BOUNDS.maxX)
  const clampedZ = clampInput(z, WALKABLE_BOUNDS.minZ, WALKABLE_BOUNDS.maxZ)
  if (isGeneratedWalkablePointSafe(clampedX, clampedZ, radius)) {
    return [clampedX, clampedZ]
  }

  let bestX = clampedX
  let bestZ = clampedZ
  let bestDistanceSq = Number.POSITIVE_INFINITY
  for (let i = 0; i < WALKABLE_POLYGONS.length; i += 1) {
    const closest = closestPointOnGeneratedPolygon(clampedX, clampedZ, WALKABLE_POLYGONS[i])
    if (closest[2] < bestDistanceSq) {
      bestX = closest[0]
      bestZ = closest[1]
      bestDistanceSq = closest[2]
    }
  }

  return [bestX, bestZ]
}

function resolveGeneratedCollisionStep(currentX: number, currentZ: number, nextX: number, nextZ: number): [number, number, number] {
  'worklet'
  if (!isGeneratedWalkablePointSafe(nextX, nextZ, PLAYER_COLLISION_RADIUS)) {
    return [currentX, currentZ, 1]
  }

  const resolved = resolveSegmentCollisionMove(
    currentX,
    currentZ,
    nextX,
    nextZ,
    COLLISION_SEGMENTS,
    PLAYER_COLLISION_RADIUS,
    COLLISION_SKIN,
    COLLISION_ITERATIONS,
    MAX_COLLISION_SUBSTEP
  )
  if (!isGeneratedWalkablePointSafe(resolved[0], resolved[1], PLAYER_COLLISION_RADIUS)) {
    return [currentX, currentZ, 1]
  }

  return resolved
}

function resolveSpzCharacterMove(currentX: number, currentZ: number, nextX: number, nextZ: number): [number, number, number] {
  'worklet'
  const deltaX = nextX - currentX
  const deltaZ = nextZ - currentZ
  const distance = Math.hypot(deltaX, deltaZ)
  const stepCount = Math.max(1, Math.ceil(distance / COLLISION_STEP_METERS))
  const stepX = deltaX / stepCount
  const stepZ = deltaZ / stepCount
  let resolvedX = currentX
  let resolvedZ = currentZ
  let hit = 0

  for (let i = 0; i < stepCount; i += 1) {
    const resolvedXStep = resolveGeneratedCollisionStep(resolvedX, resolvedZ, resolvedX + stepX, resolvedZ)
    resolvedX = resolvedXStep[0]
    resolvedZ = resolvedXStep[1]
    if (resolvedXStep[2] === 1) hit = 1

    const resolvedZStep = resolveGeneratedCollisionStep(resolvedX, resolvedZ, resolvedX, resolvedZ + stepZ)
    resolvedX = resolvedZStep[0]
    resolvedZ = resolvedZStep[1]
    if (resolvedZStep[2] === 1) hit = 1
  }

  return [resolvedX, resolvedZ, hit]
}

function screenPointToGroundFromPose(screenX: number, screenY: number, viewportWidth: number, viewportHeight: number, pose: CameraPose): Vec3 {
  'worklet'
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    return [pose.target[0], 0, pose.target[2]]
  }

  const ndcX = (screenX / viewportWidth) * 2 - 1
  const ndcY = 1 - (screenY / viewportHeight) * 2
  const aspect = viewportWidth / viewportHeight
  const forward = normalize3([pose.target[0] - pose.position[0], pose.target[1] - pose.position[1], pose.target[2] - pose.position[2]])
  const right = normalize3(cross3(forward, pose.up))
  const cameraUp = normalize3(cross3(right, forward))
  const tanHalfFov = Math.tan((pose.fovDegrees * Math.PI) / 360)
  const rayDirection = normalize3([
    forward[0] + right[0] * ndcX * tanHalfFov * aspect + cameraUp[0] * ndcY * tanHalfFov,
    forward[1] + right[1] * ndcX * tanHalfFov * aspect + cameraUp[1] * ndcY * tanHalfFov,
    forward[2] + right[2] * ndcX * tanHalfFov * aspect + cameraUp[2] * ndcY * tanHalfFov,
  ])

  if (Math.abs(rayDirection[1]) <= 0.0001) {
    return [pose.target[0], 0, pose.target[2]]
  }

  const t = -pose.position[1] / rayDirection[1]
  if (t <= 0) {
    return [pose.target[0], 0, pose.target[2]]
  }

  return [pose.position[0] + rayDirection[0] * t, 0, pose.position[2] + rayDirection[2] * t]
}

function getResolvedThirdPersonCameraPose(position: Vec3, yaw: number, pitch: number): CameraPose {
  'worklet'
  const pose = getThirdPersonCameraPose(position, yaw, pitch)
  const desired = pose.position
  const target = pose.target
  let safePosition: Vec3 = [position[0], desired[1], position[2]]

  for (let i = 1; i <= 24; i += 1) {
    const t = i / 24
    const candidate: Vec3 = [
      target[0] + (desired[0] - target[0]) * t,
      target[1] + (desired[1] - target[1]) * t,
      target[2] + (desired[2] - target[2]) * t,
    ]

    if (!isGeneratedWalkablePointSafe(candidate[0], candidate[2], CAMERA_COLLISION_RADIUS)) {
      return {
        position: safePosition,
        target: pose.target,
        up: pose.up,
        fovDegrees: pose.fovDegrees,
        near: pose.near,
        far: pose.far,
      }
    }

    safePosition = candidate
  }

  return pose
}

function resolveTapMoveTarget(screenX: number, screenY: number, viewportWidth: number, viewportHeight: number, position: Vec3, yaw: number, pitch: number): Vec3 {
  'worklet'
  const pose = getResolvedThirdPersonCameraPose(position, yaw, pitch)
  const ground = screenPointToGroundFromPose(screenX, screenY, viewportWidth, viewportHeight, pose)
  const resolved = projectToNearestGeneratedWalkablePoint(ground[0], ground[2], PLAYER_COLLISION_RADIUS)
  return [resolved[0], 0, resolved[1]]
}

function CollisionDebugBox({ collider }: { collider: GeneratedCollisionDebugBox }) {
  const { renderableManager, scene, transformManager } = useFilamentContext()
  const entity = useWorkletMemo(() => {
    'worklet'

    const debugEntity = renderableManager.createDebugCubeWireframe(collider.halfExtent as unknown as Float3, undefined, 0x00d9ffff)
    transformManager.setEntityPosition(debugEntity, collider.position as unknown as Float3, false)
    return debugEntity
  }, [collider, renderableManager, transformManager])

  useEntityInScene(scene, entity)
  return null
}

type SplatLayerProps = {
  movementState: MovementState
  joystickXInput: ReanimatedSharedValue<number>
  joystickYInput: ReanimatedSharedValue<number>
  tapScreenXInput: ReanimatedSharedValue<number>
  tapScreenYInput: ReanimatedSharedValue<number>
  tapMoveVersionInput: ReanimatedSharedValue<number>
  layoutWidthInput: ReanimatedSharedValue<number>
  layoutHeightInput: ReanimatedSharedValue<number>
  cameraYawInput: ReanimatedSharedValue<number>
  cameraPitchInput: ReanimatedSharedValue<number>
  reportPose: (x: number, z: number, hit: number) => void
}

function SpzLeonaSplatLayer({
  movementState,
  joystickXInput,
  joystickYInput,
  tapScreenXInput,
  tapScreenYInput,
  tapMoveVersionInput,
  layoutWidthInput,
  layoutHeightInput,
  cameraYawInput,
  cameraPitchInput,
  reportPose,
}: SplatLayerProps) {
  const { camera, view } = useFilamentContext()
  const joystickX = useSyncSharedValue(joystickXInput)
  const joystickY = useSyncSharedValue(joystickYInput)
  const tapScreenX = useSyncSharedValue(tapScreenXInput)
  const tapScreenY = useSyncSharedValue(tapScreenYInput)
  const tapMoveVersion = useSyncSharedValue(tapMoveVersionInput)
  const layoutWidth = useSyncSharedValue(layoutWidthInput)
  const layoutHeight = useSyncSharedValue(layoutHeightInput)
  const cameraYaw = useSyncSharedValue(cameraYawInput)
  const cameraPitch = useSyncSharedValue(cameraPitchInput)
  const splat = useGaussianSplat(WorldSpz, {
    addToScene: true,
    splatScale: SPZ_RENDERING.splatScale,
    metricScaleFactor: SPZ_WORLD.metricScaleFactor,
    groundPlaneOffset: SPZ_WORLD.groundPlaneOffset,
    flipY: SPZ_WORLD.flipY,
  })
  const lensAspect = useWorkletsSharedValue(0)
  const renderWidth = useWorkletsSharedValue(0)
  const renderHeight = useWorkletsSharedValue(0)
  const lastSortAt = useWorkletsSharedValue(-1)
  const lastPoseReportAt = useWorkletsSharedValue(-1)
  const lastTapMoveVersion = useWorkletsSharedValue(0)

  const renderCallback: RenderCallback = useCallback(
    ({ passedSeconds, timeSinceLastFrame }) => {
      'worklet'

      const aspectRatio = view.getAspectRatio()
      const renderViewport = view.getViewport()
      if (splat.state === 'loaded' && (renderWidth.value !== renderViewport.width || renderHeight.value !== renderViewport.height)) {
        renderWidth.value = renderViewport.width
        renderHeight.value = renderViewport.height
        splat.splat.setRenderSize(Math.max(1, renderViewport.width), Math.max(1, renderViewport.height))
      }
      if (lensAspect.value !== aspectRatio) {
        lensAspect.value = aspectRatio
        camera.setProjection(THIRD_PERSON_FOV, aspectRatio, THIRD_PERSON_NEAR, THIRD_PERSON_FAR, 'vertical')
      }

      const rawDt = timeSinceLastFrame ?? 1 / 60
      if (rawDt <= 0 || rawDt > 1) return

      const dt = Math.min(rawDt, MAX_FRAME_STEP)
      const position = movementState.position.value
      if (position == null) return

      if (tapMoveVersion.value !== lastTapMoveVersion.value) {
        lastTapMoveVersion.value = tapMoveVersion.value
        const screenWidth = layoutWidth.value > 0 ? layoutWidth.value : renderViewport.width
        const screenHeight = layoutHeight.value > 0 ? layoutHeight.value : renderViewport.height
        const targetPoint = resolveTapMoveTarget(
          tapScreenX.value * (renderViewport.width / screenWidth),
          tapScreenY.value * (renderViewport.height / screenHeight),
          renderViewport.width,
          renderViewport.height,
          position,
          cameraYaw.value,
          cameraPitch.value
        )
        movementState.target.value = targetPoint
        movementState.mode.value = MovementModeValue.AutoMove
        movementState.animationIndex.value = 1
      }

      const strafeInput = joystickX.value
      const forwardInput = joystickY.value
      const inputStrength = Math.min(1, Math.hypot(strafeInput, forwardInput))
      let nextX = position[0]
      let nextZ = position[2]
      let velocityX = 0
      let velocityZ = 0
      let nextMode = movementState.mode.value
      let targetForArrival = movementState.target.value

      if (inputStrength > MOVE_DEAD_ZONE) {
        const flatForward = getFlatForward(cameraYaw.value)
        const right = getRight(cameraYaw.value)
        velocityX = right[0] * strafeInput + flatForward[0] * forwardInput
        velocityZ = right[2] * strafeInput + flatForward[2] * forwardInput
        const velocityLength = Math.max(1, Math.hypot(velocityX, velocityZ))
        const step = MOVE_SPEED_METERS_PER_SECOND * inputStrength * dt
        nextX += (velocityX / velocityLength) * step
        nextZ += (velocityZ / velocityLength) * step
        nextMode = MovementModeValue.Joystick
      } else if (nextMode === MovementModeValue.AutoMove) {
        const dx = targetForArrival[0] - position[0]
        const dz = targetForArrival[2] - position[2]
        const distance = Math.hypot(dx, dz)

        if (distance <= SPZ_NAVIGATION.arrivalRadius) {
          nextMode = MovementModeValue.Idle
          targetForArrival = position
        } else {
          const step = Math.min(distance, MOVE_SPEED_METERS_PER_SECOND * dt)
          velocityX = dx / distance
          velocityZ = dz / distance
          nextX += velocityX * step
          nextZ += velocityZ * step
        }
      } else {
        nextMode = MovementModeValue.Idle
        targetForArrival = position
      }

      const resolved = resolveSpzCharacterMove(position[0], position[2], nextX, nextZ)
      const resolvedPosition: Vec3 = [resolved[0], 0, resolved[1]]
      const moved = Math.abs(resolvedPosition[0] - position[0]) > 0.0001 || Math.abs(resolvedPosition[2] - position[2]) > 0.0001
      const targetDistanceAfterMove = Math.hypot(targetForArrival[0] - resolvedPosition[0], targetForArrival[2] - resolvedPosition[2])

      if (nextMode === MovementModeValue.AutoMove && (targetDistanceAfterMove <= SPZ_NAVIGATION.arrivalRadius || (resolved[2] === 1 && !moved))) {
        nextMode = MovementModeValue.Idle
        targetForArrival = resolvedPosition
      }

      movementState.mode.value = nextMode
      movementState.joystick.value = [strafeInput, forwardInput]
      movementState.position.value = resolvedPosition
      if (nextMode === MovementModeValue.Joystick) {
        movementState.target.value = resolvedPosition
      } else if (nextMode === MovementModeValue.Idle) {
        movementState.target.value = targetForArrival
      }
      if (moved) {
        movementState.rotation.value = [0, Math.atan2(velocityX, velocityZ), 0]
      }
      const nextAnimationIndex = moved || nextMode === MovementModeValue.AutoMove ? 1 : 0
      if (movementState.animationIndex.value !== nextAnimationIndex) {
        movementState.animationIndex.value = nextAnimationIndex
      }

      const pose = getResolvedThirdPersonCameraPose(resolvedPosition, cameraYaw.value, cameraPitch.value)
      const { forward, right, cameraUp } = getCameraBasis(pose.position, pose.target)
      camera.lookAt(pose.position, pose.target, cameraUp)
      if (splat.state === 'loaded') {
        splat.splat.setCameraView(pose.position, right, cameraUp, forward)
      }
      if (splat.state === 'loaded' && passedSeconds > 1 && passedSeconds - lastSortAt.value > SORT_INTERVAL_SECONDS) {
        splat.splat.sortByView(pose.position, pose.target)
        lastSortAt.value = passedSeconds
      }
      if (inputStrength <= MOVE_DEAD_ZONE && passedSeconds - lastPoseReportAt.value > 0.2) {
        reportPose(resolvedPosition[0], resolvedPosition[2], resolved[2])
        lastPoseReportAt.value = passedSeconds
      }
    },
    [
      camera,
      cameraPitch,
      cameraYaw,
      joystickX,
      joystickY,
      layoutHeight,
      layoutWidth,
      lastPoseReportAt,
      lastSortAt,
      lastTapMoveVersion,
      lensAspect,
      movementState,
      renderHeight,
      renderWidth,
      reportPose,
      splat,
      tapMoveVersion,
      tapScreenX,
      tapScreenY,
      view,
    ]
  )

  return <FilamentView style={styles.scene} renderCallback={renderCallback} enableTransparentRendering={false} />
}

type CharacterLayerProps = {
  movementState: MovementState
  cameraYawInput: ReanimatedSharedValue<number>
  cameraPitchInput: ReanimatedSharedValue<number>
  showWireframe: boolean
}

function SpzLeonaCharacterLayer({ movementState, cameraYawInput, cameraPitchInput, showWireframe }: CharacterLayerProps) {
  const { camera, view } = useFilamentContext()
  const cameraYaw = useSyncSharedValue(cameraYawInput)
  const cameraPitch = useSyncSharedValue(cameraPitchInput)
  const lensAspect = useWorkletsSharedValue(0)

  const renderCallback: RenderCallback = useCallback(
    () => {
      'worklet'

      const aspectRatio = view.getAspectRatio()
      if (lensAspect.value !== aspectRatio) {
        lensAspect.value = aspectRatio
        camera.setProjection(THIRD_PERSON_FOV, aspectRatio, THIRD_PERSON_NEAR, THIRD_PERSON_FAR, 'vertical')
      }

      const position = movementState.position.value
      if (position == null) return

      const pose = getResolvedThirdPersonCameraPose(position, cameraYaw.value, cameraPitch.value)
      const { cameraUp } = getCameraBasis(pose.position, pose.target)
      camera.lookAt(pose.position, pose.target, cameraUp)
    },
    [camera, cameraPitch, cameraYaw, lensAspect, movementState, view]
  )

  return (
    <FilamentView style={styles.transparentScene} renderCallback={renderCallback} enableTransparentRendering={true}>
      <EnvironmentalLight source={{ uri: 'RNF_default_env_ibl.ktx' }} intensity={11000} />
      <Light type="sun" intensity={CHARACTER_KEY_LIGHT_INTENSITY} colorKelvin={5350} direction={[0.78, -0.56, -0.28]} castShadows={false} />
      <Light
        type="spot"
        intensity={CHARACTER_SPOT_LIGHT_INTENSITY}
        colorKelvin={5450}
        position={[-3.4, 2.7, -7.35]}
        direction={[0.74, -0.52, -0.42]}
        falloffRadius={7.8}
        spotLightCone={[0.18, 0.76]}
        castShadows={false}
      />
      <Light type="point" intensity={CHARACTER_WARM_FILL_INTENSITY} colorKelvin={3600} position={[2.35, 1.55, -10.2]} falloffRadius={5.4} />
      <Light type="point" intensity={CHARACTER_COOL_RIM_INTENSITY} colorKelvin={6200} position={[-1.85, 1.9, -11.5]} falloffRadius={4.8} />
      {showWireframe ? COLLISION_DEBUG_BOXES.map((collider) => <CollisionDebugBox key={collider.id} collider={collider} />) : null}
      <Model source={TargetRingModel} translate={movementState.target} scale={[0.42, 0.42, 0.42]} multiplyWithCurrentTransform={false} />
      <WalkCharacter movementState={movementState} scale={CHARACTER_SCALE} yOffset={CHARACTER_Y_OFFSET} renderPriority={7} />
    </FilamentView>
  )
}

function createMovementState(
  mode: ISharedValue<number>,
  joystick: ISharedValue<[number, number]>,
  position: ISharedValue<Vec3>,
  rotation: ISharedValue<Vec3>,
  target: ISharedValue<Vec3>,
  animationIndex: ISharedValue<number>
): MovementState {
  return {
    mode,
    joystick,
    position,
    rotation,
    target,
    animationIndex,
  }
}

function SpzLeonaRenderer() {
  const [poseLabel, setPoseLabel] = useState(`spz-leona-pose x=${SPZ_NAVIGATION.startPosition[0].toFixed(2)} z=${SPZ_NAVIGATION.startPosition[2].toFixed(2)} hit=0`)
  const reportPose = useRunOnJS((x: number, z: number, hit: number) => {
    setPoseLabel(`spz-leona-pose x=${x.toFixed(2)} z=${z.toFixed(2)} hit=${hit}`)
  }, [])

  const movementMode = useWorkletsSharedValue<number>(MovementModeValue.Idle)
  const joystick = useWorkletsSharedValue<[number, number]>([0, 0])
  const position = useWorkletsSharedValue<Vec3>(SPZ_NAVIGATION.startPosition)
  const rotation = useWorkletsSharedValue<Vec3>([0, Math.PI, 0])
  const target = useWorkletsSharedValue<Vec3>(SPZ_NAVIGATION.startPosition)
  const animationIndex = useWorkletsSharedValue<number>(0)
  const movementState = useMemo(
    () => createMovementState(movementMode, joystick, position, rotation, target, animationIndex),
    [animationIndex, joystick, movementMode, position, rotation, target]
  )

  const joystickXInput = useAnimatedSharedValue(0)
  const joystickYInput = useAnimatedSharedValue(0)
  const tapScreenXInput = useAnimatedSharedValue(0)
  const tapScreenYInput = useAnimatedSharedValue(0)
  const tapMoveVersionInput = useAnimatedSharedValue(0)
  const joystickActive = useAnimatedSharedValue(0)
  const joystickOriginX = useAnimatedSharedValue(JOYSTICK_MARGIN + JOYSTICK_RADIUS)
  const joystickOriginY = useAnimatedSharedValue(JOYSTICK_MARGIN + JOYSTICK_RADIUS)
  const joystickKnobX = useAnimatedSharedValue(0)
  const joystickKnobY = useAnimatedSharedValue(0)
  const cameraYawInput = useAnimatedSharedValue(HOME_CAMERA_YAW)
  const cameraPitchInput = useAnimatedSharedValue(DEFAULT_CAMERA_PITCH)
  const controlMode = useAnimatedSharedValue(0)
  const lookStartYaw = useAnimatedSharedValue(HOME_CAMERA_YAW)
  const lookStartPitch = useAnimatedSharedValue(DEFAULT_CAMERA_PITCH)
  const layoutWidth = useAnimatedSharedValue(0)
  const layoutHeight = useAnimatedSharedValue(0)

  const controlGesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .minDistance(0)
        .onBegin((event) => {
          const width = layoutWidth.value > 0 ? layoutWidth.value : 1
          controlMode.value = event.x <= width * 0.5 ? 1 : 2
          if (controlMode.value === 1) {
            joystickActive.value = 1
            joystickOriginX.value = event.x
            joystickOriginY.value = event.y
          }
          joystickXInput.value = 0
          joystickYInput.value = 0
          joystickKnobX.value = 0
          joystickKnobY.value = 0
          lookStartYaw.value = cameraYawInput.value
          lookStartPitch.value = cameraPitchInput.value
        })
        .onUpdate((event) => {
          const dx = event.translationX
          const dy = event.translationY
          const distance = Math.hypot(dx, dy)
          if (distance <= TAP_MOVE_MAX_DISTANCE) {
            joystickXInput.value = 0
            joystickYInput.value = 0
            joystickKnobX.value = 0
            joystickKnobY.value = 0
            return
          }

          if (controlMode.value === 2) {
            cameraYawInput.value = lookStartYaw.value - dx * LOOK_SPEED
            cameraPitchInput.value = clampInput(lookStartPitch.value - dy * LOOK_SPEED, MIN_CAMERA_PITCH, MAX_CAMERA_PITCH)
            return
          }

          const limitedDistance = Math.min(JOYSTICK_RADIUS, distance)
          const angle = Math.atan2(dy, dx)
          const strafe = clampInput(dx / JOYSTICK_RADIUS, -1, 1)
          const forward = clampInput(-dy / JOYSTICK_RADIUS, -1, 1)
          const inputLength = Math.hypot(strafe, forward)

          joystickKnobX.value = Math.cos(angle) * limitedDistance
          joystickKnobY.value = Math.sin(angle) * limitedDistance
          if (inputLength > 1) {
            joystickXInput.value = strafe / inputLength
            joystickYInput.value = forward / inputLength
          } else if (inputLength > MOVE_DEAD_ZONE) {
            joystickXInput.value = strafe
            joystickYInput.value = forward
          } else {
            joystickXInput.value = 0
            joystickYInput.value = 0
          }
        })
        .onFinalize((event) => {
          if (Math.hypot(event.translationX, event.translationY) <= TAP_MOVE_MAX_DISTANCE) {
            tapScreenXInput.value = event.x
            tapScreenYInput.value = event.y
            tapMoveVersionInput.value += 1
          }
          controlMode.value = 0
          joystickActive.value = 0
          joystickXInput.value = 0
          joystickYInput.value = 0
          joystickKnobX.value = 0
          joystickKnobY.value = 0
        }),
    [
      cameraPitchInput,
      cameraYawInput,
      controlMode,
      joystickActive,
      joystickKnobX,
      joystickKnobY,
      joystickOriginX,
      joystickOriginY,
      joystickXInput,
      joystickYInput,
      layoutWidth,
      lookStartPitch,
      lookStartYaw,
      tapMoveVersionInput,
      tapScreenXInput,
      tapScreenYInput,
    ]
  )

  const joystickBaseStyle = useAnimatedStyle(() => {
    const fallbackX = JOYSTICK_MARGIN + JOYSTICK_RADIUS
    const fallbackY = Math.max(JOYSTICK_MARGIN + JOYSTICK_RADIUS, layoutHeight.value - JOYSTICK_MARGIN - JOYSTICK_RADIUS)
    const centerX = joystickActive.value === 1 ? joystickOriginX.value : fallbackX
    const centerY = joystickActive.value === 1 ? joystickOriginY.value : fallbackY

    return {
      opacity: joystickActive.value === 1 ? 1 : 0.68,
      transform: [{ translateX: centerX - JOYSTICK_RADIUS }, { translateY: centerY - JOYSTICK_RADIUS }],
    }
  })

  const joystickKnobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: joystickKnobX.value }, { translateY: joystickKnobY.value }],
  }))

  return (
    <View
      style={styles.root}
      onLayout={(event) => {
        layoutWidth.value = event.nativeEvent.layout.width
        layoutHeight.value = event.nativeEvent.layout.height
      }}>
      <StatusBar hidden />
      <FilamentScene antiAliasing="none" dithering="none" postProcessing={false} screenSpaceRefraction={false} shadowing={false}>
        <SpzLeonaSplatLayer
          movementState={movementState}
          joystickXInput={joystickXInput}
          joystickYInput={joystickYInput}
          tapScreenXInput={tapScreenXInput}
          tapScreenYInput={tapScreenYInput}
          tapMoveVersionInput={tapMoveVersionInput}
          layoutWidthInput={layoutWidth}
          layoutHeightInput={layoutHeight}
          cameraYawInput={cameraYawInput}
          cameraPitchInput={cameraPitchInput}
          reportPose={reportPose}
        />
      </FilamentScene>
      <View pointerEvents="none" style={styles.characterLayer}>
        <FilamentScene
          antiAliasing="FXAA"
          dithering="temporal"
          postProcessing={true}
          screenSpaceRefraction={false}
          shadowing={false}
          ambientOcclusionOptions={CHARACTER_AMBIENT_OCCLUSION_OPTIONS}
          bloomOptions={CHARACTER_BLOOM_OPTIONS}
          temporalAntiAliasingOptions={CHARACTER_TEMPORAL_AA_OPTIONS}>
          <SpzLeonaCharacterLayer
            movementState={movementState}
            cameraYawInput={cameraYawInput}
            cameraPitchInput={cameraPitchInput}
            showWireframe={false}
          />
        </FilamentScene>
      </View>
      <View pointerEvents="box-none" style={styles.controlLayer}>
        <GestureDetector gesture={controlGesture}>
          <Animated.View style={styles.controlPad} />
        </GestureDetector>
        <Animated.View pointerEvents="none" style={[styles.joystickBase, joystickBaseStyle]}>
          <Animated.View pointerEvents="none" style={[styles.joystickKnob, joystickKnobStyle]} />
        </Animated.View>
      </View>
      <View pointerEvents="none" style={styles.badge}>
        <Text style={styles.badgeText}>SPZ + Leona</Text>
      </View>
      <Text accessible accessibilityLabel={poseLabel} pointerEvents="none" style={styles.hiddenPose} testID="spz-leona-pose">
        {poseLabel}
      </Text>
    </View>
  )
}

export function SpzLeonaWalk() {
  return <SpzLeonaRenderer />
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  scene: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0f172a',
  },
  characterLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },
  transparentScene: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
  },
  controlLayer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 30,
  },
  controlPad: {
    ...StyleSheet.absoluteFillObject,
  },
  badge: {
    alignSelf: 'center',
    backgroundColor: 'rgba(8,12,18,0.48)',
    borderRadius: 8,
    bottom: 18,
    paddingHorizontal: 10,
    paddingVertical: 7,
    position: 'absolute',
    zIndex: 35,
  },
  badgeText: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 12,
    fontWeight: '700',
  },
  hiddenPose: {
    color: 'rgba(255,255,255,0.01)',
    fontSize: 1,
    height: 8,
    left: 0,
    position: 'absolute',
    top: 0,
    width: 160,
  },
  joystickBase: {
    backgroundColor: 'rgba(8,12,18,0.18)',
    borderColor: 'rgba(255,255,255,0.34)',
    borderRadius: JOYSTICK_RADIUS,
    borderWidth: 1,
    height: JOYSTICK_SIZE,
    left: 0,
    position: 'absolute',
    top: 0,
    width: JOYSTICK_SIZE,
    zIndex: 36,
  },
  joystickKnob: {
    backgroundColor: 'rgba(133,230,255,0.72)',
    borderColor: 'rgba(255,255,255,0.58)',
    borderRadius: JOYSTICK_KNOB_SIZE / 2,
    borderWidth: 1,
    height: JOYSTICK_KNOB_SIZE,
    left: JOYSTICK_RADIUS - JOYSTICK_KNOB_SIZE / 2,
    position: 'absolute',
    top: JOYSTICK_RADIUS - JOYSTICK_KNOB_SIZE / 2,
    width: JOYSTICK_KNOB_SIZE,
  },
})
