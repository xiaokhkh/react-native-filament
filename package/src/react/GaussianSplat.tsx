import React from 'react'
import { BufferSource } from '../hooks/useBuffer'
import { FilamentGaussianSplat, UseGaussianSplatConfigParams, useGaussianSplat } from '../hooks/useGaussianSplat'
import { extractTransformationProps, TransformationProps } from '../types/TransformProps'
import { useApplyTransformations } from '../hooks/internal/useApplyTransformations'
import { AABB } from '../types'

export type GaussianSplatProps = UseGaussianSplatConfigParams &
  TransformationProps & {
    source: BufferSource
  }

export function GaussianSplat({ source, ...restProps }: GaussianSplatProps) {
  const [_transformProps, splatProps] = extractTransformationProps(restProps)
  const splat = useGaussianSplat(source, splatProps)

  return <GaussianSplatRenderer splat={splat} {...restProps} />
}

export type GaussianSplatRendererProps = {
  splat: FilamentGaussianSplat
} & TransformationProps

export function GaussianSplatRenderer({ splat, ...restProps }: GaussianSplatRendererProps) {
  const [transformProps] = extractTransformationProps(restProps)
  const boundingBox = splat.state === 'loaded' ? (splat.boundingBox as unknown as AABB) : undefined
  const rootEntity = splat.state === 'loaded' ? splat.rootEntity : undefined

  useApplyTransformations({ transformProps, to: rootEntity, aabb: boundingBox })

  return null
}
