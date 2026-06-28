import React, { useCallback, useEffect, useState } from 'react'
import { StatusBar, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import {
  type AmbientOcclusionOptions,
  type BloomOptions,
  EnvironmentalLight,
  FilamentScene,
  FilamentView,
  type FogOptions,
  type FrameRateOptions,
  Light,
  Model,
  Skybox,
  type TemporalAntiAliasingOptions,
  useFilamentContext,
  type RenderCallback,
} from 'react-native-filament'
import { useSharedValue } from 'react-native-worklets-core'

import ApartmentModel from '@assets/empty-apartment.glb'
import TargetRingModel from '@assets/target-ring.glb'
import {
  APARTMENT_CAMERA,
  APARTMENT_NAVIGATION,
  resolveWalkablePoint,
  screenPointToApartmentFloor,
  type Viewport,
} from './navigation'
import { MovementModeValue, useTapMoveControls } from './useTapMoveControls'
import { WalkCharacter } from './WalkCharacter'

const MOVE_SPEED_METERS_PER_SECOND = 2
const MAX_FRAME_STEP = 1 / 20
const WINDOW_SPOT_BASE_INTENSITY = 95_000
const WINDOW_SPOT_BOOST_INTENSITY = 285_000
const CHARACTER_SUN_FILL_MAX_INTENSITY = 48_000

const AMBIENT_OCCLUSION_OPTIONS = {
  enabled: true,
  radius: 0.22,
  power: 0.62,
  bias: 0.01,
  resolution: 0.5,
  intensity: 0.42,
  bilateralThreshold: 0.04,
  quality: 'MEDIUM',
  lowPassFilter: 'MEDIUM',
  upsampling: 'MEDIUM',
} satisfies AmbientOcclusionOptions

const BLOOM_OPTIONS = {
  enabled: true,
  strength: 0.1,
  resolution: 420,
  levels: 5,
  blendMode: 'INTERPOLATE',
  threshold: false,
  quality: 'MEDIUM',
  lensFlare: false,
  starburst: false,
  chromaticAberration: 0,
} satisfies BloomOptions

const TEMPORAL_AA_OPTIONS = {
  enabled: true,
  feedback: 0.12,
  lodBias: -0.8,
  sharpness: 0.12,
  boxClipping: 'ACCURATE',
  jitterPattern: 'HALTON_23_X8',
  filterHistory: true,
  filterInput: true,
  preventFlickering: true,
} satisfies TemporalAntiAliasingOptions

const FRAME_RATE_OPTIONS = {
  headRoomRatio: 0.18,
  scaleRate: 0.125,
  history: 15,
  interval: 1,
} satisfies FrameRateOptions

const VOLUMETRIC_FOG_OPTIONS = {
  enabled: true,
  distance: 0.9,
  cutOffDistance: 11.5,
  maximumOpacity: 0.24,
  height: -0.18,
  heightFalloff: 0.16,
  color: [1.0, 0.94, 0.82],
  density: 0.028,
  inScatteringStart: 0.35,
  inScatteringSize: 58,
  fogColorFromIbl: false,
} satisfies FogOptions

function ApartmentCamera({ viewport }: { viewport: Viewport }) {
  const { camera } = useFilamentContext()

  useEffect(() => {
    const aspect = viewport.width > 0 && viewport.height > 0 ? viewport.width / viewport.height : 16 / 9
    camera.lookAt(APARTMENT_CAMERA.position, APARTMENT_CAMERA.target, APARTMENT_CAMERA.up)
    camera.setProjection(APARTMENT_CAMERA.fovDegrees, aspect, APARTMENT_CAMERA.near, APARTMENT_CAMERA.far, 'vertical')
  }, [camera, viewport.height, viewport.width])

  return null
}

function ApartmentScene({
  viewport,
  movementState,
}: {
  viewport: Viewport
  movementState: ReturnType<typeof useTapMoveControls>['movementState']
}) {
  const windowSpotIntensity = useSharedValue(WINDOW_SPOT_BASE_INTENSITY)
  const characterSunFillIntensity = useSharedValue(0)

  const renderCallback: RenderCallback = useCallback(
    ({ timeSinceLastFrame }) => {
      'worklet'

      const rawDt = timeSinceLastFrame ?? 1 / 60
      if (rawDt <= 0 || rawDt > 1) return

      const dt = Math.min(rawDt, MAX_FRAME_STEP)
      const position = movementState.position.value
      if (position == null || position.length < 3) return

      let nextX = position[0]
      let nextZ = position[2]
      let velocityX = 0
      let velocityZ = 0

      if (movementState.mode.value === MovementModeValue.Joystick) {
        const stick = movementState.joystick.value
        velocityX = stick[0]
        velocityZ = stick[1]
        nextX += velocityX * MOVE_SPEED_METERS_PER_SECOND * dt
        nextZ += velocityZ * MOVE_SPEED_METERS_PER_SECOND * dt
      } else if (movementState.mode.value === MovementModeValue.AutoMove) {
        const target = movementState.target.value
        const dx = target[0] - position[0]
        const dz = target[2] - position[2]
        const distance = Math.sqrt(dx * dx + dz * dz)

        if (distance <= APARTMENT_NAVIGATION.arrivalRadius) {
          movementState.mode.value = MovementModeValue.Idle
        } else {
          const step = Math.min(distance, MOVE_SPEED_METERS_PER_SECOND * dt)
          velocityX = dx / distance
          velocityZ = dz / distance
          nextX += velocityX * step
          nextZ += velocityZ * step
        }
      }

      const resolved = resolveWalkablePoint(APARTMENT_NAVIGATION, [nextX, 0, nextZ])
      const moved = Math.abs(resolved[0] - position[0]) > 0.0001 || Math.abs(resolved[2] - position[2]) > 0.0001

      if (moved) {
        movementState.rotation.value = [0, Math.atan2(velocityX, velocityZ), 0]
      }

      const beamStartX = -3.88
      const beamStartZ = 0.78
      const beamEndX = -0.54
      const beamEndZ = -1.54
      const beamX = beamEndX - beamStartX
      const beamZ = beamEndZ - beamStartZ
      const beamLength = Math.sqrt(beamX * beamX + beamZ * beamZ) || 1
      const beamDirectionX = beamX / beamLength
      const beamDirectionZ = beamZ / beamLength
      const pointX = resolved[0] - beamStartX
      const pointZ = resolved[2] - beamStartZ
      const along = (pointX * beamDirectionX + pointZ * beamDirectionZ) / beamLength
      const clampedAlong = Math.max(0, Math.min(1, along))
      const perpendicular = Math.abs(pointX * beamDirectionZ - pointZ * beamDirectionX)
      const width = 0.62 + clampedAlong * 0.88
      const widthEdge = Math.max(0, Math.min(1, (perpendicular - width * 0.62) / (width * 0.38))) || 0
      const widthSmooth = widthEdge * widthEdge * (3 - 2 * widthEdge)
      const headEdge = Math.max(0, Math.min(1, (along - 0.02) / 0.16))
      const tailEdge = Math.max(0, Math.min(1, (1 - along - 0.02) / 0.2))
      const lengthFalloff = headEdge * headEdge * (3 - 2 * headEdge) * tailEdge * tailEdge * (3 - 2 * tailEdge)
      const widthFalloff = 1 - widthSmooth
      const sunPatchFactor = Math.max(0, Math.min(1, widthFalloff * lengthFalloff))
      const follow = Math.min(1, dt * 7.5)
      const nextWindowSpotIntensity = WINDOW_SPOT_BASE_INTENSITY + WINDOW_SPOT_BOOST_INTENSITY * sunPatchFactor
      windowSpotIntensity.value += (nextWindowSpotIntensity - windowSpotIntensity.value) * follow
      characterSunFillIntensity.value += (CHARACTER_SUN_FILL_MAX_INTENSITY * sunPatchFactor - characterSunFillIntensity.value) * follow

      const nextAnimationIndex = moved ? 1 : 0
      if (movementState.animationIndex.value !== nextAnimationIndex) {
        movementState.animationIndex.value = nextAnimationIndex
      }
      movementState.position.value = resolved
    },
    [characterSunFillIntensity, movementState, windowSpotIntensity]
  )

  return (
    <FilamentScene
      postProcessing={true}
      antiAliasing="FXAA"
      dithering="temporal"
      shadowing={true}
      screenSpaceRefraction={true}
      ambientOcclusionOptions={AMBIENT_OCCLUSION_OPTIONS}
      bloomOptions={BLOOM_OPTIONS}
      temporalAntiAliasingOptions={TEMPORAL_AA_OPTIONS}
      fogOptions={VOLUMETRIC_FOG_OPTIONS}
      frameRateOptions={FRAME_RATE_OPTIONS}>
      <FilamentView style={styles.scene} renderCallback={renderCallback}>
        <ApartmentCamera viewport={viewport} />
        <Skybox colorInHex="#c7e9ff" showSun={true} envIntensity={14000} />
        <EnvironmentalLight source={{ uri: 'RNF_default_env_ibl.ktx' }} intensity={14000} />
        <Light type="sun" intensity={140000} colorKelvin={5350} direction={[0.78, -0.56, -0.28]} castShadows={true} />
        <Light
          type="spot"
          intensity={windowSpotIntensity}
          colorKelvin={5450}
          position={[-4.62, 2.85, 1.82]}
          direction={[0.78, -0.54, -0.31]}
          falloffRadius={7.2}
          spotLightCone={[0.18, 0.74]}
          castShadows={true}
        />
        <Light type="point" intensity={characterSunFillIntensity} colorKelvin={5650} position={[-1.65, 1.15, -0.45]} falloffRadius={3.4} />
        <Light type="point" intensity={12000} colorKelvin={3300} position={[-3.6, 1.35, -1.45]} falloffRadius={4.6} />
        <Light type="point" intensity={10000} colorKelvin={4850} position={[-4.05, 2.2, 1.45]} falloffRadius={4.2} />
        <Light type="point" intensity={10000} colorKelvin={3500} position={[2.45, 1.45, -1.95]} falloffRadius={4.5} />
        <Light type="point" intensity={7000} colorKelvin={4500} position={[0, 2.5, 0.4]} falloffRadius={4.8} />
        <Model source={ApartmentModel} castShadow={true} receiveShadow={true} multiplyWithCurrentTransform={false} />
        <Model source={TargetRingModel} translate={movementState.target} scale={[0.48, 0.48, 0.48]} multiplyWithCurrentTransform={false} />
        <WalkCharacter movementState={movementState} />
      </FilamentView>
    </FilamentScene>
  )
}

export function ApartmentExample() {
  const [viewport, setViewport] = useState<Viewport>({ width: 0, height: 0 })
  const { panHandlers, movementState } = useTapMoveControls({
    navigation: APARTMENT_NAVIGATION,
    viewport,
    screenPointToFloor: (screenX, screenY, currentViewport) => screenPointToApartmentFloor(screenX, screenY, currentViewport),
  })

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    setViewport((current) => {
      if (current.width === width && current.height === height) return current
      return { width, height }
    })
  }, [])

  return (
    <View style={styles.root} onLayout={onLayout}>
      <StatusBar hidden />
      <ApartmentScene viewport={viewport} movementState={movementState} />
      <View style={StyleSheet.absoluteFill} {...panHandlers} />
      <View pointerEvents="none" style={styles.guide}>
        <Text style={styles.guideText}>点地面移动 · 拖动连续行走 · 公寓 GLB 示例</Text>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#111827',
  },
  scene: {
    flex: 1,
    backgroundColor: '#b4a894',
  },
  guide: {
    alignSelf: 'center',
    backgroundColor: 'rgba(8,12,18,0.54)',
    borderRadius: 8,
    bottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    position: 'absolute',
  },
  guideText: {
    color: 'rgba(255,255,255,0.88)',
    fontSize: 12,
    fontWeight: '700',
  },
})
