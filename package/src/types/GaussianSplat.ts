import type { RigidBody } from '../bullet'
import type { Box } from './Boxes'
import type { Entity } from './Entity'
import type { Float3 } from './Math'
import type { PointerHolder } from './PointerHolder'

export interface GaussianSplatAsset extends PointerHolder {
  getEntity(): Entity
  getBoundingBox(): Box
  setCameraView(cameraPosition: Float3, cameraRight: Float3, cameraUp: Float3, cameraForward: Float3): void
  setRenderSize(width: number, height: number): void
  sortByView(cameraPosition: Float3, cameraTarget: Float3): void
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
