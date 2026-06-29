import { useEffect, useMemo } from 'react'
import { BufferSource, useBuffer } from './useBuffer'
import { useDisposableResource } from './useDisposableResource'
import { useFilamentContext } from './useFilamentContext'
import { useWorkletEffect } from './useWorkletEffect'
import { BulletAPI } from '../bullet/bulletApi'
import { useRigidBody } from '../bullet/hooks/useRigidBody'
import { Box, Entity, GaussianSplatAsset, GaussianSplatCollision, GaussianSplatRenderOptions } from '../types'
import { RigidBody } from '../bullet'
import DefaultGaussianSplatMaterial from '../../assets/spz_gaussian_splat.filamat'

type NormalizedCollisionConfig = Exclude<GaussianSplatCollision, boolean>

const MIN_COLLIDER_HALF_EXTENT = 0.001

function normalizeColliderHalfExtent(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return MIN_COLLIDER_HALF_EXTENT
  }
  return Math.max(value, MIN_COLLIDER_HALF_EXTENT)
}

export interface UseGaussianSplatConfigParams {
  /**
   * Whether source data should be released after the native splat buffers are created.
   * @default true
   */
  shouldReleaseSourceData?: boolean

  /**
   * Whether the splat entity should be added to the current scene.
   * @default true
   */
  addToScene?: boolean

  /**
   * Deterministically downsample the SPZ for lower memory usage. Pass `undefined` to render all splats.
   */
  maxSplats?: number

  /**
   * Multiplies each rendered Gaussian billboard radius.
   * @default 1
   */
  splatScale?: number

  /**
   * Applies the same semantic world transform used by World Labs/Image Blast assets.
   * The SPZ is transformed as: scale, optional 180deg X flip, then ground-plane offset.
   */
  metricScaleFactor?: number
  groundPlaneOffset?: number
  flipY?: boolean

  /**
   * Runtime material parameters that control the Gaussian projection and alpha falloff.
   * These are intentionally separate from splatScale, which changes decoded radii.
   */
  renderOptions?: GaussianSplatRenderOptions

  /**
   * Creates a static Bullet box collision body from the decoded SPZ bounds.
   */
  collision?: GaussianSplatCollision
}

export type FilamentGaussianSplat =
  | {
      state: 'loaded'
      splat: GaussianSplatAsset
      boundingBox: Box
      rootEntity: Entity
      rigidBody?: RigidBody
    }
  | {
      state: 'loading'
    }

export function useGaussianSplat(source: BufferSource, props?: UseGaussianSplatConfigParams): FilamentGaussianSplat {
  const {
    shouldReleaseSourceData = true,
    addToScene = true,
    maxSplats,
    splatScale,
    metricScaleFactor,
    groundPlaneOffset,
    flipY,
    renderOptions,
    collision = false,
  } = props ?? {}
  const maxStdDev = renderOptions?.maxStdDev
  const minPixelRadius = renderOptions?.minPixelRadius
  const maxPixelRadius = renderOptions?.maxPixelRadius
  const preBlurAmount = renderOptions?.preBlurAmount
  const blurAmount = renderOptions?.blurAmount
  const minAlpha = renderOptions?.minAlpha
  const alphaGain = renderOptions?.alphaGain
  const focalAdjustment = renderOptions?.focalAdjustment
  const falloffGain = renderOptions?.falloffGain
  const clipXY = renderOptions?.clipXY
  const highAlphaMax = renderOptions?.highAlphaMax
  const highAlphaStdDevBoost = renderOptions?.highAlphaStdDevBoost
  const { engine, scene, workletContext } = useFilamentContext()
  const spzBuffer = useBuffer({ source, releaseOnUnmount: false })
  const materialBuffer = useBuffer({ source: DefaultGaussianSplatMaterial })

  const splat = useDisposableResource(() => {
    if (spzBuffer == null || materialBuffer == null) return

    return workletContext.runAsync(() => {
      'worklet'

      const loadedSplat = engine.loadSpz(spzBuffer, materialBuffer, maxSplats, splatScale, metricScaleFactor, groundPlaneOffset, flipY)
      if (shouldReleaseSourceData) {
        spzBuffer.release()
      }
      return loadedSplat
    })
  }, [engine, flipY, groundPlaneOffset, materialBuffer, maxSplats, metricScaleFactor, shouldReleaseSourceData, splatScale, spzBuffer, workletContext])

  useWorkletEffect(() => {
    'worklet'
    if (splat == null || !addToScene) return

    const entity = splat.getEntity()
    scene.addEntity(entity)
    return () => {
      'worklet'
      scene.removeEntity(entity)
    }
  })

  useWorkletEffect(() => {
    'worklet'
    if (splat == null) return
    if (typeof splat.setRenderOptions !== 'function') return

    splat.setRenderOptions(
      maxStdDev,
      minPixelRadius,
      maxPixelRadius,
      preBlurAmount,
      blurAmount,
      minAlpha,
      alphaGain,
      focalAdjustment,
      falloffGain,
      highAlphaMax,
      highAlphaStdDevBoost,
      clipXY
    )
  })

  const boundingBox = useMemo(() => {
    if (splat == null) return undefined
    return splat.getBoundingBox()
  }, [splat])

  const rootEntity = useMemo(() => {
    if (splat == null) return undefined
    return splat.getEntity()
  }, [splat])

  const collisionEnabled = collision !== false
  const collisionConfig: NormalizedCollisionConfig = collision !== false && collision !== true ? collision : {}
  const collisionWorld = collisionConfig.world
  const collisionId = collisionConfig.id ?? 'spz-collider'
  const collisionFriction = collisionConfig.friction
  const collisionCallback = collisionConfig.collisionCallback
  const onBodyCreated = collisionConfig.onBodyCreated

  const halfX = boundingBox?.halfExtent[0]
  const halfY = boundingBox?.halfExtent[1]
  const halfZ = boundingBox?.halfExtent[2]
  const centerX = boundingBox?.center[0]
  const centerY = boundingBox?.center[1]
  const centerZ = boundingBox?.center[2]

  const collisionShape = useMemo(() => {
    if (!collisionEnabled || halfX == null || halfY == null || halfZ == null) return undefined
    return BulletAPI.createBoxShape(
      normalizeColliderHalfExtent(halfX),
      normalizeColliderHalfExtent(halfY),
      normalizeColliderHalfExtent(halfZ)
    )
  }, [collisionEnabled, halfX, halfY, halfZ])

  const rigidBody = useRigidBody(
    centerX != null && centerY != null && centerZ != null && collisionShape != null
      ? {
          mass: 0,
          origin: [centerX, centerY, centerZ],
          shape: collisionShape,
          world: collisionWorld,
          id: collisionId,
          friction: collisionFriction,
          collisionCallback,
        }
      : undefined
  )

  useEffect(() => {
    if (rigidBody == null || onBodyCreated == null) return
    onBodyCreated(rigidBody)
  }, [onBodyCreated, rigidBody])

  if (spzBuffer == null || splat == null || boundingBox == null || rootEntity == null) {
    return {
      state: 'loading',
    }
  }

  return {
    state: 'loaded',
    splat,
    boundingBox,
    rootEntity,
    rigidBody,
  }
}
