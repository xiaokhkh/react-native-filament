export type GaussianSplatRenderOptions = {
  readonly maxStdDev?: number
  readonly minPixelRadius?: number
  readonly maxPixelRadius?: number
  readonly preBlurAmount?: number
  readonly blurAmount?: number
  readonly minAlpha?: number
  readonly alphaGain?: number
  readonly focalAdjustment?: number
  readonly falloffGain?: number
  readonly clipXY?: number
  readonly highAlphaMax?: number
  readonly highAlphaStdDevBoost?: number
}

export type GaussianSplatRenderingPresetName = 'spark-web-default' | 'mobile-sharp' | 'mobile-crisp'

export type GaussianSplatRenderingPreset = {
  readonly name: GaussianSplatRenderingPresetName
  readonly splatScale: number
  readonly focalAdjustment: number
  readonly renderOptions: GaussianSplatRenderOptions
}

const SPARK_WEB_RENDER_OPTIONS = {
  maxStdDev: Math.sqrt(8),
  minPixelRadius: 0,
  maxPixelRadius: 512,
  preBlurAmount: 0,
  blurAmount: 0.3,
  minAlpha: 0.5 / 255,
  alphaGain: 2,
  focalAdjustment: 1,
  falloffGain: 1,
  clipXY: 1.4,
  highAlphaMax: 5,
  highAlphaStdDevBoost: 0.7,
} satisfies GaussianSplatRenderOptions

export const SPARK_WEB_GAUSSIAN_SPLAT_RENDERING_PRESET = {
  name: 'spark-web-default',
  splatScale: 1,
  focalAdjustment: 1,
  renderOptions: SPARK_WEB_RENDER_OPTIONS,
} satisfies GaussianSplatRenderingPreset

export const MOBILE_SHARP_GAUSSIAN_SPLAT_RENDERING_PRESET = {
  name: 'mobile-sharp',
  splatScale: 0.42,
  focalAdjustment: 1.25,
  renderOptions: {
    ...SPARK_WEB_RENDER_OPTIONS,
    blurAmount: 0.015,
    minAlpha: 0.00035,
    focalAdjustment: 1.25,
    highAlphaStdDevBoost: 0.62,
  },
} satisfies GaussianSplatRenderingPreset

export const MOBILE_CRISP_GAUSSIAN_SPLAT_RENDERING_PRESET = {
  name: 'mobile-crisp',
  splatScale: 0.4,
  focalAdjustment: 1.58,
  renderOptions: {
    ...SPARK_WEB_RENDER_OPTIONS,
    maxPixelRadius: 96,
    blurAmount: 0.004,
    minAlpha: 0.00018,
    focalAdjustment: 1.58,
    falloffGain: 1.35,
    clipXY: 1.6,
    highAlphaMax: 5,
    highAlphaStdDevBoost: 0.54,
  },
} satisfies GaussianSplatRenderingPreset

export const SPZ_GAUSSIAN_SPLAT_RENDER_PRESETS = {
  sparkWebDefault: SPARK_WEB_GAUSSIAN_SPLAT_RENDERING_PRESET,
  mobileSharp: MOBILE_SHARP_GAUSSIAN_SPLAT_RENDERING_PRESET,
  mobileCrisp: MOBILE_CRISP_GAUSSIAN_SPLAT_RENDERING_PRESET,
} as const
