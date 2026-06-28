import { useCallback, useMemo, useRef, useState } from 'react'
import type { GestureResponderEvent, ViewProps } from 'react-native'
import { useSharedValue } from 'react-native-worklets-core'

import type { Vec2, Vec3, Viewport, WalkNavigation } from './navigation'

export const MovementModeValue = {
  Idle: 0,
  Joystick: 1,
  AutoMove: 2,
} as const

export type MovementModeName = 'idle' | 'joystick' | 'autoMove' | 'tapPending'

export type MovementState = {
  mode: ReturnType<typeof useSharedValue<number>>
  joystick: ReturnType<typeof useSharedValue<Vec2>>
  position: ReturnType<typeof useSharedValue<Vec3>>
  rotation: ReturnType<typeof useSharedValue<Vec3>>
  target: ReturnType<typeof useSharedValue<Vec3>>
  animationIndex: ReturnType<typeof useSharedValue<number>>
}

export type MovementDebugState = {
  mode: MovementModeName
  joystick: Vec2
  target: Vec3 | null
}

const JOYSTICK_RADIUS_PX = 80
const JOYSTICK_DEAD_ZONE_PX = 8
const DRAG_THRESHOLD_PX = 14

export function useTapMoveControls({
  navigation,
  viewport,
  screenPointToFloor,
}: {
  navigation: WalkNavigation
  viewport: Viewport
  screenPointToFloor: (screenX: number, screenY: number, viewport: Viewport, movementState: MovementState) => Vec3
}) {
  const movementMode = useSharedValue<number>(MovementModeValue.Idle)
  const joystick = useSharedValue<Vec2>([0, 0])
  const position = useSharedValue<Vec3>(navigation.startPosition)
  const rotation = useSharedValue<Vec3>([0, navigation.startYaw, 0])
  const target = useSharedValue<Vec3>(navigation.startPosition)
  const animationIndex = useSharedValue<number>(0)

  const movementState = useMemo<MovementState>(
    () => ({
      mode: movementMode,
      joystick,
      position,
      rotation,
      target,
      animationIndex,
    }),
    [animationIndex, joystick, movementMode, position, rotation, target]
  )

  const gestureRef = useRef({
    startX: 0,
    startY: 0,
    mode: 'idle' as MovementModeName,
  })

  const [debugState, setDebugState] = useState<MovementDebugState>({
    mode: 'idle',
    joystick: [0, 0],
    target: null,
  })

  const stopJoystick = useCallback(() => {
    joystick.value = [0, 0]
    if (movementMode.value === MovementModeValue.Joystick) {
      movementMode.value = MovementModeValue.Idle
    }
    animationIndex.value = 0
    gestureRef.current.mode = 'idle'
    setDebugState((current) => ({
      ...current,
      mode: movementMode.value === MovementModeValue.AutoMove ? 'autoMove' : 'idle',
      joystick: [0, 0],
    }))
  }, [animationIndex, joystick, movementMode])

  const updateJoystick = useCallback(
    (dx: number, dy: number) => {
      const distance = Math.hypot(dx, dy)
      if (distance < JOYSTICK_DEAD_ZONE_PX) {
        joystick.value = [0, 0]
        setDebugState((current) => ({ ...current, mode: 'joystick', joystick: [0, 0] }))
        return
      }

      const clampedDistance = Math.min(distance, JOYSTICK_RADIUS_PX)
      const strength = clampedDistance / JOYSTICK_RADIUS_PX
      const normalizedX = (dx / distance) * strength
      const normalizedZ = (dy / distance) * strength
      joystick.value = [normalizedX, normalizedZ]
      setDebugState((current) => ({
        ...current,
        mode: 'joystick',
        joystick: [normalizedX, normalizedZ],
      }))
    },
    [joystick]
  )

  const panHandlers = useMemo<ViewProps>(
    () => ({
      onStartShouldSetResponder: () => true,
      onMoveShouldSetResponder: () => true,
      onResponderGrant: (event: GestureResponderEvent) => {
        const { locationX, locationY } = event.nativeEvent
        gestureRef.current = {
          startX: locationX,
          startY: locationY,
          mode: 'tapPending',
        }
        joystick.value = [0, 0]
        setDebugState((current) => ({
          ...current,
          mode: 'tapPending',
          joystick: [0, 0],
        }))
      },
      onResponderMove: (event: GestureResponderEvent) => {
        const { locationX, locationY } = event.nativeEvent
        const dx = locationX - gestureRef.current.startX
        const dy = locationY - gestureRef.current.startY
        const distance = Math.hypot(dx, dy)

        if (gestureRef.current.mode !== 'joystick' && distance > DRAG_THRESHOLD_PX) {
          gestureRef.current.mode = 'joystick'
          movementMode.value = MovementModeValue.Joystick
          animationIndex.value = 1
          updateJoystick(dx, dy)
          return
        }

        if (gestureRef.current.mode === 'joystick') {
          updateJoystick(dx, dy)
        }
      },
      onResponderRelease: (event: GestureResponderEvent) => {
        if (gestureRef.current.mode === 'joystick') {
          stopJoystick()
          return
        }

        const { locationX, locationY } = event.nativeEvent
        const nextTarget = screenPointToFloor(locationX, locationY, viewport, movementState)
        target.value = nextTarget
        movementMode.value = MovementModeValue.AutoMove
        animationIndex.value = 1
        gestureRef.current.mode = 'idle'
        setDebugState({
          mode: 'autoMove',
          joystick: [0, 0],
          target: nextTarget,
        })
      },
      onResponderTerminate: () => {
        stopJoystick()
      },
    }),
    [animationIndex, joystick, movementMode, movementState, screenPointToFloor, stopJoystick, target, updateJoystick, viewport]
  )

  return {
    panHandlers,
    movementState,
    debugState,
  }
}
