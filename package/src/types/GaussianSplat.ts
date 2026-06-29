import type { RigidBody } from '../bullet'
import type { Box } from './Boxes'
import type { Entity } from './Entity'
import type { Float3 } from './Math'
import type { PointerHolder } from './PointerHolder'

export interface GaussianSplatRenderOptions {
  /**
   * Ellipse cutoff in standard deviations. Spark-like default: sqrt(8).
   */
  maxStdDev?: number
  minPixelRadius?: number
  maxPixelRadius?: number
  preBlurAmount?: number
  blurAmount?: number
  minAlpha?: number
  alphaGain?: number
  focalAdjustment?: number
  falloffGain?: number
  clipXY?: number
  highAlphaMax?: number
  highAlphaStdDevBoost?: number
}

export interface GaussianSplatAsset extends PointerHolder {
  getEntity(): Entity
  getBoundingBox(): Box
  setCameraView(cameraPosition: Float3, cameraRight: Float3, cameraUp: Float3, cameraForward: Float3): void
  setRenderSize(width: number, height: number): void
  setRenderOptions(
    maxStdDev: number | undefined,
    minPixelRadius: number | undefined,
    maxPixelRadius: number | undefined,
    preBlurAmount: number | undefined,
    blurAmount: number | undefined,
    minAlpha: number | undefined,
    alphaGain: number | undefined,
    focalAdjustment: number | undefined,
    falloffGain: number | undefined,
    highAlphaMax: number | undefined,
    highAlphaStdDevBoost: number | undefined,
    clipXY: number | undefined
  ): void
  sortByView(cameraPosition: Float3, cameraTarget: Float3): void
  readonly supportsRenderOptions: boolean
  readonly pointCount: number
  readonly renderedPointCount: number
}

export type GaussianSplatCollision =
  | false
  | true
  | {
      world?: import('../bullet').DiscreteDynamicWorld
      id?: string
      friction?: number
      collisionCallback?: import('../bullet').CollisionCallback
      onBodyCreated?: (body: RigidBody) => void
    }
