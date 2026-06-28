import React, { useCallback, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue as useAnimatedSharedValue } from 'react-native-reanimated'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import {
  DefaultLight,
  FilamentScene,
  FilamentView,
  useEntityInScene,
  useFilamentContext,
  useGaussianSplat,
  useSyncSharedValue,
  useWorkletMemo,
  type Float3,
  type RenderCallback,
} from 'react-native-filament'
import type { CollisionDebugBox as GeneratedCollisionDebugBox } from 'react-native-filament-spz'
import { useSharedValue } from 'react-native-worklets-core'

import WorldSpz from '@assets/1-world-500k.spz'
import { cross3, normalize3, SPZ_FREE_CAMERA, SPZ_RENDERING, SPZ_WORLD } from './navigation'
import { SPZ_COLLISION } from '../generated/beloSpzCollision'

const HOME_YAW = Math.atan2(
  SPZ_FREE_CAMERA.target[0] - SPZ_FREE_CAMERA.position[0],
  -(SPZ_FREE_CAMERA.target[2] - SPZ_FREE_CAMERA.position[2])
)
const DEFAULT_PITCH = -0.08
const MOVE_SPEED = 3.2
const STRAFE_SCALE = 0.48
const LOOK_SPEED = 0.0032
const LOOK_SMOOTHING = 0.18
const CAMERA_SMOOTHING = 0.18
const MIN_PITCH = -0.5
const MAX_PITCH = 0.38
const MOVE_DEAD_ZONE = 0.08
const CENTER_HOLD_PUSH = 0.7
const JOYSTICK_TOUCH_WIDTH_RATIO = 0.48
const JOYSTICK_RADIUS = 64
const JOYSTICK_SIZE = JOYSTICK_RADIUS * 2
const JOYSTICK_KNOB_SIZE = 42
const JOYSTICK_MARGIN = 24
const SORT_INTERVAL_SECONDS = 0.08
const COLLISION_DEBUG_BOXES = SPZ_COLLISION.debugBoxes

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

function clampInput(value: number, min: number, max: number) {
  'worklet'
  return Math.max(min, Math.min(max, value))
}

function smoothingAlpha(amount: number, deltaTime: number) {
  'worklet'
  return 1 - Math.pow(1 - amount, deltaTime * 60)
}

function getForward(yaw: number, pitch: number): Float3 {
  'worklet'
  const cp = Math.cos(pitch)
  return [Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp]
}

function getFlatForward(yaw: number): Float3 {
  'worklet'
  return normalize3([Math.sin(yaw), 0, -Math.cos(yaw)])
}

function getRight(yaw: number): Float3 {
  'worklet'
  return [Math.cos(yaw), 0, Math.sin(yaw)]
}

function SpzFreeCameraRenderer() {
  const [showWireframe, setShowWireframe] = useState(false)
  const { camera, view } = useFilamentContext()
  const splat = useGaussianSplat(WorldSpz, {
    addToScene: true,
    splatScale: SPZ_RENDERING.splatScale,
    metricScaleFactor: SPZ_WORLD.metricScaleFactor,
    groundPlaneOffset: SPZ_WORLD.groundPlaneOffset,
    flipY: SPZ_WORLD.flipY,
  })

  const eyeX = useSharedValue(SPZ_FREE_CAMERA.position[0])
  const eyeY = useSharedValue(SPZ_FREE_CAMERA.position[1])
  const eyeZ = useSharedValue(SPZ_FREE_CAMERA.position[2])
  const smoothYaw = useSharedValue(HOME_YAW)
  const smoothPitch = useSharedValue(DEFAULT_PITCH)
  const lensAspect = useSharedValue(0)
  const renderWidth = useSharedValue(0)
  const renderHeight = useSharedValue(0)
  const lastSortAt = useSharedValue(-1)

  const rawYawInput = useAnimatedSharedValue(HOME_YAW)
  const rawPitchInput = useAnimatedSharedValue(DEFAULT_PITCH)
  const joystickPushInput = useAnimatedSharedValue(0)
  const joystickStrafeInput = useAnimatedSharedValue(0)
  const joystickActive = useAnimatedSharedValue(0)
  const joystickOriginX = useAnimatedSharedValue(JOYSTICK_MARGIN + JOYSTICK_RADIUS)
  const joystickOriginY = useAnimatedSharedValue(JOYSTICK_MARGIN + JOYSTICK_RADIUS)
  const joystickKnobX = useAnimatedSharedValue(0)
  const joystickKnobY = useAnimatedSharedValue(0)
  const lookActive = useAnimatedSharedValue(0)
  const lookStartYaw = useAnimatedSharedValue(HOME_YAW)
  const lookStartPitch = useAnimatedSharedValue(DEFAULT_PITCH)
  const layoutWidth = useAnimatedSharedValue(0)
  const layoutHeight = useAnimatedSharedValue(0)

  const rawYaw = useSyncSharedValue(rawYawInput)
  const rawPitch = useSyncSharedValue(rawPitchInput)
  const joystickPush = useSyncSharedValue(joystickPushInput)
  const joystickStrafe = useSyncSharedValue(joystickStrafeInput)

  const renderCallback: RenderCallback = useCallback(
    ({ passedSeconds, timeSinceLastFrame }) => {
      'worklet'

      const aspectRatio = view.getAspectRatio()
      const viewport = view.getViewport()
      if (splat.state === 'loaded' && (renderWidth.value !== viewport.width || renderHeight.value !== viewport.height)) {
        renderWidth.value = viewport.width
        renderHeight.value = viewport.height
        splat.splat.setRenderSize(Math.max(1, viewport.width), Math.max(1, viewport.height))
      }
      if (lensAspect.value !== aspectRatio) {
        lensAspect.value = aspectRatio
        camera.setProjection(SPZ_FREE_CAMERA.fovDegrees, aspectRatio, SPZ_FREE_CAMERA.near, SPZ_FREE_CAMERA.far, 'vertical')
      }

      const lookAlpha = smoothingAlpha(LOOK_SMOOTHING, timeSinceLastFrame)
      smoothYaw.value += (rawYaw.value - smoothYaw.value) * lookAlpha
      smoothPitch.value += (rawPitch.value - smoothPitch.value) * lookAlpha
      eyeY.value += (SPZ_FREE_CAMERA.position[1] - eyeY.value) * smoothingAlpha(CAMERA_SMOOTHING, timeSinceLastFrame)

      const push = joystickPush.value
      const strafe = joystickStrafe.value
      if (Math.abs(push) > MOVE_DEAD_ZONE || Math.abs(strafe) > MOVE_DEAD_ZONE) {
        const forwardFlat = getFlatForward(smoothYaw.value)
        const right = getRight(smoothYaw.value)
        const inputLength = Math.max(1, Math.hypot(push, strafe))
        const step = MOVE_SPEED * Math.min(1, Math.hypot(push, strafe)) * timeSinceLastFrame
        eyeX.value += ((forwardFlat[0] * push + right[0] * strafe * STRAFE_SCALE) / inputLength) * step
        eyeZ.value += ((forwardFlat[2] * push + right[2] * strafe * STRAFE_SCALE) / inputLength) * step
      }

      const eye: Float3 = [eyeX.value, eyeY.value, eyeZ.value]
      const forward = getForward(smoothYaw.value, smoothPitch.value)
      const right = getRight(smoothYaw.value)
      const cameraUp = normalize3(cross3(right, forward))
      const target: Float3 = [eye[0] + forward[0], eye[1] + forward[1], eye[2] + forward[2]]
      camera.lookAt(eye, target, cameraUp)
      if (splat.state === 'loaded') {
        splat.splat.setCameraView(eye, right, cameraUp, forward)
      }
      if (splat.state === 'loaded' && passedSeconds > 1 && passedSeconds - lastSortAt.value > SORT_INTERVAL_SECONDS) {
        splat.splat.sortByView(eye, target)
        lastSortAt.value = passedSeconds
      }
    },
    [
      camera,
      eyeX,
      eyeY,
      eyeZ,
      joystickPush,
      joystickStrafe,
      lastSortAt,
      lensAspect,
      rawPitch,
      rawYaw,
      renderHeight,
      renderWidth,
      smoothPitch,
      smoothYaw,
      splat,
      view,
    ]
  )

  const controlGesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .minDistance(0)
        .onBegin((event) => {
          const width = layoutWidth.value
          const height = layoutHeight.value
          const fallbackLeftX = JOYSTICK_MARGIN + JOYSTICK_RADIUS
          const fallbackRightX = Math.max(fallbackLeftX, width - JOYSTICK_MARGIN - JOYSTICK_RADIUS)
          const fallbackY = Math.max(fallbackLeftX, height - JOYSTICK_MARGIN - JOYSTICK_RADIUS)
          const inLeftJoystick = Math.hypot(event.x - fallbackLeftX, event.y - fallbackY) <= JOYSTICK_RADIUS * 1.55
          const inMirroredJoystick = Math.hypot(event.x - fallbackRightX, event.y - fallbackY) <= JOYSTICK_RADIUS * 1.55
          const inBottomMoveBand = height > 0 && event.y >= height * 0.52
          const isMoveTouch = width <= 0 || event.x <= width * JOYSTICK_TOUCH_WIDTH_RATIO || inBottomMoveBand || inLeftJoystick || inMirroredJoystick
          const shouldCenterPush = width <= 0 || event.x <= width * JOYSTICK_TOUCH_WIDTH_RATIO || inLeftJoystick

          if (isMoveTouch) {
            lookActive.value = 0
            joystickActive.value = 1
            joystickOriginX.value = event.x
            joystickOriginY.value = event.y
            joystickStrafeInput.value = 0
            joystickPushInput.value = shouldCenterPush ? CENTER_HOLD_PUSH : 0
            joystickKnobX.value = 0
            joystickKnobY.value = shouldCenterPush ? -JOYSTICK_RADIUS * CENTER_HOLD_PUSH : 0
            return
          }

          lookActive.value = 1
          lookStartYaw.value = rawYawInput.value
          lookStartPitch.value = rawPitchInput.value
          joystickActive.value = 0
          joystickPushInput.value = 0
          joystickStrafeInput.value = 0
          joystickKnobX.value = 0
          joystickKnobY.value = 0
        })
        .onUpdate((event) => {
          if (joystickActive.value === 1) {
            const dx = event.translationX
            const dy = event.translationY
            const distance = Math.hypot(dx, dy)
            const limitedDistance = Math.min(JOYSTICK_RADIUS, distance)
            const angle = Math.atan2(dy, dx)
            const strafe = clampInput(dx / JOYSTICK_RADIUS, -1, 1)
            const push = clampInput(-dy / JOYSTICK_RADIUS, -1, 1)
            const inputLength = Math.hypot(strafe, push)

            joystickKnobX.value = Math.cos(angle) * limitedDistance
            joystickKnobY.value = Math.sin(angle) * limitedDistance
            if (inputLength > 1) {
              joystickStrafeInput.value = strafe / inputLength
              joystickPushInput.value = push / inputLength
            } else if (inputLength > MOVE_DEAD_ZONE) {
              joystickStrafeInput.value = strafe
              joystickPushInput.value = push
            } else {
              joystickStrafeInput.value = 0
              joystickPushInput.value = CENTER_HOLD_PUSH
              joystickKnobX.value = 0
              joystickKnobY.value = -JOYSTICK_RADIUS * CENTER_HOLD_PUSH
            }
            return
          }

          if (lookActive.value === 1) {
            rawYawInput.value = lookStartYaw.value - event.translationX * LOOK_SPEED
            rawPitchInput.value = clampInput(lookStartPitch.value - event.translationY * LOOK_SPEED, MIN_PITCH, MAX_PITCH)
          }
        })
        .onFinalize(() => {
          lookActive.value = 0
          joystickActive.value = 0
          joystickPushInput.value = 0
          joystickStrafeInput.value = 0
          joystickKnobX.value = 0
          joystickKnobY.value = 0
        }),
    [
      joystickActive,
      joystickKnobX,
      joystickKnobY,
      joystickOriginX,
      joystickOriginY,
      joystickPushInput,
      joystickStrafeInput,
      layoutHeight,
      layoutWidth,
      lookActive,
      lookStartPitch,
      lookStartYaw,
      rawPitchInput,
      rawYawInput,
    ]
  )

  const joystickBaseStyle = useAnimatedStyle(() => {
    const fallbackX = JOYSTICK_MARGIN + JOYSTICK_RADIUS
    const fallbackY = Math.max(JOYSTICK_MARGIN + JOYSTICK_RADIUS, layoutHeight.value - JOYSTICK_MARGIN - JOYSTICK_RADIUS)
    const centerX = joystickActive.value === 1 ? joystickOriginX.value : fallbackX
    const centerY = joystickActive.value === 1 ? joystickOriginY.value : fallbackY

    return {
      opacity: joystickActive.value === 1 ? 1 : 0.72,
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
      <GestureDetector gesture={controlGesture}>
        <FilamentView style={styles.filamentView} renderCallback={renderCallback}>
          <DefaultLight />
          {showWireframe ? COLLISION_DEBUG_BOXES.map((collider) => <CollisionDebugBox key={collider.id} collider={collider} />) : null}
        </FilamentView>
      </GestureDetector>
      <View pointerEvents="box-none" style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={showWireframe ? '切换到贴图模式' : '切换到网格模式'}
          onPress={() => setShowWireframe((value) => !value)}
          style={styles.modeButton}>
          <Text style={styles.modeButtonIcon}>{showWireframe ? '▣' : '▦'}</Text>
          <Text style={styles.modeButtonText}>{showWireframe ? '贴图' : '网格'}</Text>
        </Pressable>
        <Animated.View pointerEvents="none" style={[styles.joystickBase, joystickBaseStyle]}>
          <Animated.View pointerEvents="none" style={[styles.joystickKnob, joystickKnobStyle]} />
        </Animated.View>
        <View pointerEvents="none" style={styles.guide}>
          <Text style={styles.guideText}>SPZ 自由相机 · 左侧推进 · 右侧转视角</Text>
        </View>
      </View>
    </View>
  )
}

export function SpzFreeCamera() {
  return (
    <FilamentScene antiAliasing="none" dithering="none" postProcessing={false} screenSpaceRefraction={false} shadowing={false}>
      <SpzFreeCameraRenderer />
    </FilamentScene>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0f172a',
  },
  filamentView: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0f172a',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 30,
  },
  modeButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(8,12,18,0.58)',
    borderColor: 'rgba(255,255,255,0.28)',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    position: 'absolute',
    right: 18,
    top: 18,
    zIndex: 35,
  },
  modeButtonIcon: {
    color: 'rgba(137,236,255,0.95)',
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 17,
  },
  modeButtonText: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 16,
  },
  guide: {
    alignSelf: 'center',
    backgroundColor: 'rgba(8,12,18,0.46)',
    borderRadius: 8,
    bottom: 18,
    paddingHorizontal: 10,
    paddingVertical: 7,
    position: 'absolute',
  },
  guideText: {
    color: 'rgba(255,255,255,0.86)',
    fontSize: 12,
    fontWeight: '600',
  },
  joystickBase: {
    backgroundColor: 'rgba(8,12,18,0.18)',
    borderColor: 'rgba(255,255,255,0.32)',
    borderRadius: JOYSTICK_RADIUS,
    borderWidth: 1,
    height: JOYSTICK_SIZE,
    left: 0,
    position: 'absolute',
    top: 0,
    width: JOYSTICK_SIZE,
    zIndex: 31,
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
