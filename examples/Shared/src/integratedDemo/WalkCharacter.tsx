import React from 'react'
import {
  Animator,
  ModelRenderer,
  RenderCallbackContext,
  useFilamentContext,
  useModel,
  useWorkletEffect,
  type Float3,
  type RenderCallback,
} from 'react-native-filament'

import LeonaModel from '@assets/leona-apartment.glb'
import type { MovementState } from './useTapMoveControls'

export function WalkCharacter({
  movementState,
  scale = [1, 1, 1],
  yOffset = 0,
  opacity,
  renderPriority,
}: {
  movementState: MovementState
  scale?: Float3
  yOffset?: number
  opacity?: number
  renderPriority?: number
}) {
  const model = useModel(LeonaModel)
  const { renderableManager, transformManager } = useFilamentContext()

  useWorkletEffect(() => {
    'worklet'

    if (model.state !== 'loaded') return
    if (opacity != null) {
      renderableManager.setAssetEntitiesOpacity(model.asset, opacity)
    }
    if (renderPriority != null) {
      renderableManager.setAssetEntitiesPriority(model.asset, renderPriority)
    }
  })

  const updateCharacterTransform: RenderCallback = React.useCallback(() => {
    'worklet'

    if (model.state !== 'loaded') return

    const position = movementState.position.value
    const rotation = movementState.rotation.value
    if (position == null || rotation == null) return

    const transform = transformManager
      .createIdentityMatrix()
      .scaling(scale)
      .rotate(rotation[1], [0, 1, 0])
      .translate([position[0], position[1] + yOffset, position[2]])
    transformManager.setTransform(model.rootEntity, transform)
  }, [model, movementState, scale, transformManager, yOffset])

  RenderCallbackContext.useRenderCallback(updateCharacterTransform, [updateCharacterTransform])

  return (
    <ModelRenderer model={model} castShadow={true} receiveShadow={true}>
      <Animator animationIndex={movementState.animationIndex} transitionDuration={0.12} />
    </ModelRenderer>
  )
}
