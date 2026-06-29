#include "RNFGaussianSplatWrapper.h"

#include "RNFLogger.h"

#include <backend/BufferDescriptor.h>
#include <filament/RenderableManager.h>
#include <math/norm.h>
#include <math/vec2.h>
#include <math/vec4.h>
#include <utils/EntityManager.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <utility>
#include <vector>

namespace margelo {

using namespace filament;
using namespace math;

namespace {

constexpr auto TAG = "GaussianSplat";
constexpr float DEFAULT_SPLAT_SCALE = 1.0f;
constexpr float DEFAULT_METRIC_SCALE_FACTOR = 1.0f;
constexpr float DEFAULT_GROUND_PLANE_OFFSET = 0.0f;
constexpr float MIN_SPLAT_RADIUS = 0.00004f;
constexpr float MAX_SPLAT_RADIUS = 1.0f;

float clampRadius(float radius) {
  if (!std::isfinite(radius)) {
    return MIN_SPLAT_RADIUS;
  }
  return std::clamp(radius, MIN_SPLAT_RADIUS, MAX_SPLAT_RADIUS);
}

void freeIndexBuffer(void* buffer, size_t, void*) {
  delete[] reinterpret_cast<uint32_t*>(buffer);
}

float3 cross3(const float3& a, const float3& b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}

float dot3(const float3& a, const float3& b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

float length3(const float3& value) {
  return std::sqrt(dot3(value, value));
}

float3 normalize3(const float3& value) {
  const float len = length3(value);
  if (len <= 0.00001f || !std::isfinite(len)) {
    return {0.0f, 0.0f, -1.0f};
  }
  return value / len;
}

float3 vecFromJs(const std::vector<double>& value, const char* name) {
  if (value.size() != 3) {
    throw std::runtime_error(std::string(name) + " must contain exactly 3 numbers");
  }
  return {static_cast<float>(value[0]), static_cast<float>(value[1]), static_cast<float>(value[2])};
}

float3 rotateByQuaternion(const float3& vector, const float rotation[4]) {
  const float3 q = {rotation[0], rotation[1], rotation[2]};
  const float3 t = 2.0f * cross3(q, vector);
  return vector + rotation[3] * t + cross3(q, t);
}

float normalizedMetricScale(std::optional<double> metricScaleFactor) {
  const float scale = static_cast<float>(metricScaleFactor.value_or(DEFAULT_METRIC_SCALE_FACTOR));
  if (!std::isfinite(scale) || std::abs(scale) <= 0.000001f) {
    return DEFAULT_METRIC_SCALE_FACTOR;
  }
  return scale;
}

float normalizedGroundPlaneOffset(std::optional<double> groundPlaneOffset) {
  const float offset = static_cast<float>(groundPlaneOffset.value_or(DEFAULT_GROUND_PLANE_OFFSET));
  return std::isfinite(offset) ? offset : DEFAULT_GROUND_PLANE_OFFSET;
}

float finiteOr(std::optional<double> value, float fallback) {
  if (!value.has_value()) {
    return fallback;
  }

  const float parsed = static_cast<float>(value.value());
  return std::isfinite(parsed) ? parsed : fallback;
}

float minValueOr(std::optional<double> value, float fallback, float minValue) {
  return std::max(finiteOr(value, fallback), minValue);
}

float3 transformSpzPosition(const float3& value, const GaussianSplatWorldTransform& transform) {
  const float s = transform.metricScaleFactor;
  if (transform.flipY) {
    return {value.x * s, transform.groundPlaneOffset - value.y * s, -value.z * s};
  }
  return {value.x * s, transform.groundPlaneOffset + value.y * s, value.z * s};
}

float3 transformSpzDirection(const float3& value, const GaussianSplatWorldTransform& transform) {
  const float s = transform.metricScaleFactor;
  if (transform.flipY) {
    return {value.x * s, -value.y * s, -value.z * s};
  }
  return value * s;
}

bool hasParameter(MaterialInstance* materialInstance, const char* name) {
  if (materialInstance == nullptr || materialInstance->getMaterial() == nullptr) {
    return false;
  }
  return materialInstance->getMaterial()->hasParameter(name);
}

void setFloatParameterIfPresent(MaterialInstance* materialInstance, const char* name, float value) {
  if (!hasParameter(materialInstance, name)) {
    return;
  }
  materialInstance->setParameter(name, value);
}

} // namespace

struct GaussianSplatResource::GaussianSplatVertex {
  float3 position;
  float4 corner;
  float4 axis0;
  float4 axis1;
  float4 axis2;
  float4 color;
};

namespace {

void freeVertexBuffer(void* buffer, size_t, void*) {
  delete[] reinterpret_cast<GaussianSplatResource::GaussianSplatVertex*>(buffer);
}

} // namespace

GaussianSplatResource::GaussianSplatResource(std::shared_ptr<Engine> engine, std::shared_ptr<Dispatcher> dispatcher,
                                             std::shared_ptr<Scene> scene, std::shared_ptr<FilamentBuffer> spzBuffer,
                                             std::shared_ptr<FilamentBuffer> materialBuffer, std::optional<int> maxSplats,
                                             std::optional<double> splatScale, std::optional<double> metricScaleFactor,
                                             std::optional<double> groundPlaneOffset, std::optional<bool> flipY)
    : _engine(engine), _dispatcher(dispatcher), _scene(scene), _entity(utils::EntityManager::get().create()) {
  if (_engine == nullptr) {
    throw std::runtime_error("Engine is null");
  }
  if (_scene == nullptr) {
    throw std::runtime_error("Scene is null");
  }
  if (spzBuffer == nullptr) {
    throw std::runtime_error("SPZ buffer is null");
  }
  if (materialBuffer == nullptr) {
    throw std::runtime_error("Gaussian splat material buffer is null");
  }

  const auto buffer = spzBuffer->getBuffer();
  const auto cloud = SpzDecoder::decodeLegacyGzip(buffer->getData(), buffer->getSize());
  _pointCount = cloud.numPoints;
  const GaussianSplatWorldTransform worldTransform = {
      .metricScaleFactor = normalizedMetricScale(metricScaleFactor),
      .groundPlaneOffset = normalizedGroundPlaneOffset(groundPlaneOffset),
      .flipY = flipY.value_or(false),
  };
  buildRenderable(cloud, materialBuffer, maxSplats, static_cast<float>(splatScale.value_or(DEFAULT_SPLAT_SCALE)), worldTransform);
}

GaussianSplatResource::~GaussianSplatResource() {
  auto engine = _engine;
  auto scene = _scene;
  auto entity = _entity;
  auto vertexBuffer = _vertexBuffer;
  auto indexBuffer = _indexBuffer;
  auto material = _material;
  auto materialInstance = _materialInstance;

  _dispatcher->runAsync([engine, scene, entity, vertexBuffer, indexBuffer, material, materialInstance]() {
    Logger::log(TAG, "Destroying Gaussian splat renderable...");
    if (scene != nullptr) {
      scene->remove(entity);
    }
    if (engine != nullptr) {
      engine->destroy(entity);
      if (materialInstance != nullptr) {
        engine->destroy(materialInstance);
      }
      if (material != nullptr) {
        engine->destroy(material);
      }
      if (vertexBuffer != nullptr) {
        engine->destroy(vertexBuffer);
      }
      if (indexBuffer != nullptr) {
        engine->destroy(indexBuffer);
      }
    }
    utils::EntityManager::get().destroy(entity);
  });
}

utils::Entity GaussianSplatResource::getEntity() const {
  return _entity;
}

Box GaussianSplatResource::getBoundingBox() const {
  return _boundingBox;
}

int GaussianSplatResource::getPointCount() const {
  return _pointCount;
}

int GaussianSplatResource::getRenderedPointCount() const {
  return _renderedPointCount;
}

void GaussianSplatResource::setCameraView(std::vector<double> cameraPosition, std::vector<double> cameraRight, std::vector<double> cameraUp,
                                          std::vector<double> cameraForward) {
  if (_materialInstance == nullptr) {
    return;
  }

  const float3 eye = vecFromJs(cameraPosition, "cameraPosition");
  const float3 right = normalize3(vecFromJs(cameraRight, "cameraRight"));
  const float3 up = normalize3(vecFromJs(cameraUp, "cameraUp"));
  const float3 forward = normalize3(vecFromJs(cameraForward, "cameraForward"));
  _materialInstance->setParameter("cameraPosition", eye);
  _materialInstance->setParameter("cameraRight", right);
  _materialInstance->setParameter("cameraUp", up);
  _materialInstance->setParameter("cameraForward", forward);
}

void GaussianSplatResource::setRenderSize(double width, double height) {
  if (_materialInstance == nullptr) {
    return;
  }

  const float safeWidth = std::isfinite(width) && width > 0.0 ? static_cast<float>(width) : 1.0f;
  const float safeHeight = std::isfinite(height) && height > 0.0 ? static_cast<float>(height) : 1.0f;
  _materialInstance->setParameter("renderSize", float2({safeWidth, safeHeight}));
}

void GaussianSplatResource::setRenderOptions(std::optional<double> maxStdDev, std::optional<double> minPixelRadius,
                                             std::optional<double> maxPixelRadius, std::optional<double> preBlurAmount,
                                             std::optional<double> blurAmount, std::optional<double> minAlpha,
                                             std::optional<double> alphaGain, std::optional<double> focalAdjustment,
                                             std::optional<double> falloffGain, std::optional<double> highAlphaMax,
                                             std::optional<double> highAlphaStdDevBoost, std::optional<double> clipXY) {
  _renderOptions.maxStdDev = minValueOr(maxStdDev, _renderOptions.maxStdDev, 0.000001f);
  _renderOptions.minPixelRadius = minValueOr(minPixelRadius, _renderOptions.minPixelRadius, 0.0f);
  _renderOptions.maxPixelRadius = minValueOr(maxPixelRadius, _renderOptions.maxPixelRadius, 1.0f);
  _renderOptions.preBlurAmount = minValueOr(preBlurAmount, _renderOptions.preBlurAmount, 0.0f);
  _renderOptions.blurAmount = minValueOr(blurAmount, _renderOptions.blurAmount, 0.0f);
  _renderOptions.minAlpha = minValueOr(minAlpha, _renderOptions.minAlpha, 0.0f);
  _renderOptions.alphaGain = minValueOr(alphaGain, _renderOptions.alphaGain, 0.0f);
  _renderOptions.focalAdjustment = minValueOr(focalAdjustment, _renderOptions.focalAdjustment, 0.000001f);
  _renderOptions.falloffGain = minValueOr(falloffGain, _renderOptions.falloffGain, 0.0f);
  _renderOptions.clipXY = minValueOr(clipXY, _renderOptions.clipXY, 1.0f);
  _renderOptions.highAlphaMax = minValueOr(highAlphaMax, _renderOptions.highAlphaMax, 1.0f);
  _renderOptions.highAlphaStdDevBoost = minValueOr(highAlphaStdDevBoost, _renderOptions.highAlphaStdDevBoost, 0.0f);
  applyRenderOptions();
}

bool GaussianSplatResource::supportsRenderOptions() const {
  return _materialInstance != nullptr && hasParameter(_materialInstance, "maxStdDev") &&
         hasParameter(_materialInstance, "minPixelRadius") && hasParameter(_materialInstance, "maxPixelRadius") &&
         hasParameter(_materialInstance, "preBlurAmount") && hasParameter(_materialInstance, "blurAmount") &&
         hasParameter(_materialInstance, "minAlpha") && hasParameter(_materialInstance, "alphaGain") &&
         hasParameter(_materialInstance, "focalAdjustment") && hasParameter(_materialInstance, "falloffGain") &&
         hasParameter(_materialInstance, "clipXY") && hasParameter(_materialInstance, "highAlphaMax") &&
         hasParameter(_materialInstance, "highAlphaStdDevBoost");
}

void GaussianSplatResource::sortByView(std::vector<double> cameraPosition, std::vector<double> cameraTarget) {
  if (_indexBuffer == nullptr || _splatCenters.empty()) {
    return;
  }

  static_cast<void>(cameraTarget);
  const float3 eye = vecFromJs(cameraPosition, "cameraPosition");
  std::vector<std::pair<float, uint32_t>> order;
  order.reserve(_splatCenters.size());
  for (uint32_t i = 0; i < _splatCenters.size(); ++i) {
    const float3 toSplat = _splatCenters[i] - eye;
    order.emplace_back(dot3(toSplat, toSplat), i);
  }
  std::sort(order.begin(), order.end(), [](const auto& lhs, const auto& rhs) {
    return lhs.first > rhs.first;
  });

  auto* indices = new uint32_t[_indexCount];
  for (uint32_t i = 0; i < order.size(); ++i) {
    const uint32_t vertexBase = order[i].second * 4;
    const uint32_t indexBase = i * 6;
    indices[indexBase + 0] = vertexBase + 0;
    indices[indexBase + 1] = vertexBase + 1;
    indices[indexBase + 2] = vertexBase + 2;
    indices[indexBase + 3] = vertexBase + 2;
    indices[indexBase + 4] = vertexBase + 3;
    indices[indexBase + 5] = vertexBase + 0;
  }

  _indexBuffer->setBuffer(*_engine, IndexBuffer::BufferDescriptor(indices, _indexCount * sizeof(uint32_t), freeIndexBuffer));
}

Material* GaussianSplatResource::createMaterial(std::shared_ptr<FilamentBuffer> materialBuffer) {
  const auto buffer = materialBuffer->getBuffer();
  if (buffer->getSize() == 0) {
    throw std::runtime_error("Gaussian splat material buffer is empty");
  }

  return Material::Builder().package(buffer->getData(), buffer->getSize()).build(*_engine);
}

void GaussianSplatResource::applyRenderOptions() {
  if (_materialInstance == nullptr) {
    return;
  }

  setFloatParameterIfPresent(_materialInstance, "maxStdDev", _renderOptions.maxStdDev);
  setFloatParameterIfPresent(_materialInstance, "minPixelRadius", _renderOptions.minPixelRadius);
  setFloatParameterIfPresent(_materialInstance, "maxPixelRadius", _renderOptions.maxPixelRadius);
  setFloatParameterIfPresent(_materialInstance, "preBlurAmount", _renderOptions.preBlurAmount);
  setFloatParameterIfPresent(_materialInstance, "blurAmount", _renderOptions.blurAmount);
  setFloatParameterIfPresent(_materialInstance, "minAlpha", _renderOptions.minAlpha);
  setFloatParameterIfPresent(_materialInstance, "alphaGain", _renderOptions.alphaGain);
  setFloatParameterIfPresent(_materialInstance, "focalAdjustment", _renderOptions.focalAdjustment);
  setFloatParameterIfPresent(_materialInstance, "falloffGain", _renderOptions.falloffGain);
  setFloatParameterIfPresent(_materialInstance, "clipXY", _renderOptions.clipXY);
  setFloatParameterIfPresent(_materialInstance, "highAlphaMax", _renderOptions.highAlphaMax);
  setFloatParameterIfPresent(_materialInstance, "highAlphaStdDevBoost", _renderOptions.highAlphaStdDevBoost);
}

void GaussianSplatResource::buildRenderable(const DecodedSpzCloud& cloud, std::shared_ptr<FilamentBuffer> materialBuffer,
                                            std::optional<int> maxSplats, float splatScale,
                                            GaussianSplatWorldTransform worldTransform) {
  const int sourceCount = static_cast<int>(cloud.splats.size());
  if (sourceCount <= 0) {
    throw std::runtime_error("Decoded SPZ cloud is empty");
  }

  int renderCount = sourceCount;
  if (maxSplats.has_value() && maxSplats.value() > 0) {
    renderCount = std::min(renderCount, maxSplats.value());
  }
  _renderedPointCount = renderCount;

  const uint32_t vertexCount = static_cast<uint32_t>(renderCount * 4);
  const uint32_t indexCount = static_cast<uint32_t>(renderCount * 6);
  _indexCount = indexCount;
  auto* vertices = new GaussianSplatVertex[vertexCount];
  auto* indices = new uint32_t[indexCount];
  _splatCenters.resize(renderCount);

  float3 minPoint = {std::numeric_limits<float>::max(), std::numeric_limits<float>::max(), std::numeric_limits<float>::max()};
  float3 maxPoint = {std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest(), std::numeric_limits<float>::lowest()};
  static constexpr float2 corners[4] = {{-1.0f, -1.0f}, {1.0f, -1.0f}, {1.0f, 1.0f}, {-1.0f, 1.0f}};
  for (int i = 0; i < renderCount; ++i) {
    const int sourceIndex = renderCount == sourceCount ? i : static_cast<int>((static_cast<int64_t>(i) * sourceCount) / renderCount);
    const DecodedSpzSplat& splat = cloud.splats[sourceIndex];

    const float3 center = transformSpzPosition({splat.position[0], splat.position[1], splat.position[2]}, worldTransform);
    _splatCenters[i] = center;
    const float3 axis0 = transformSpzDirection(rotateByQuaternion({clampRadius(std::exp(splat.scale[0]) * splatScale), 0.0f, 0.0f},
                                                                  splat.rotation),
                                               worldTransform);
    const float3 axis1 = transformSpzDirection(rotateByQuaternion({0.0f, clampRadius(std::exp(splat.scale[1]) * splatScale), 0.0f},
                                                                  splat.rotation),
                                               worldTransform);
    const float3 axis2 = transformSpzDirection(rotateByQuaternion({0.0f, 0.0f, clampRadius(std::exp(splat.scale[2]) * splatScale)},
                                                                  splat.rotation),
                                               worldTransform);
    const float radius = std::max({length(axis0), length(axis1), length(axis2)});
    const uint32_t vertexBase = static_cast<uint32_t>(i * 4);
    const uint32_t indexBase = static_cast<uint32_t>(i * 6);
    const float4 color = {splat.color[0], splat.color[1], splat.color[2], splat.color[3]};

    for (int c = 0; c < 4; ++c) {
      vertices[vertexBase + c] = {
          .position = center,
          .corner = {corners[c].x, corners[c].y, 0.0f, 1.0f},
          .axis0 = {axis0.x, axis0.y, axis0.z, 0.0f},
          .axis1 = {axis1.x, axis1.y, axis1.z, 0.0f},
          .axis2 = {axis2.x, axis2.y, axis2.z, 0.0f},
          .color = color,
      };
    }

    indices[indexBase + 0] = vertexBase + 0;
    indices[indexBase + 1] = vertexBase + 1;
    indices[indexBase + 2] = vertexBase + 2;
    indices[indexBase + 3] = vertexBase + 2;
    indices[indexBase + 4] = vertexBase + 3;
    indices[indexBase + 5] = vertexBase + 0;

    minPoint.x = std::min(minPoint.x, center.x - radius);
    minPoint.y = std::min(minPoint.y, center.y - radius);
    minPoint.z = std::min(minPoint.z, center.z - radius);
    maxPoint.x = std::max(maxPoint.x, center.x + radius);
    maxPoint.y = std::max(maxPoint.y, center.y + radius);
    maxPoint.z = std::max(maxPoint.z, center.z + radius);
  }

  _boundingBox = Box().set(minPoint, maxPoint);
  _vertexBuffer = VertexBuffer::Builder()
                      .vertexCount(vertexCount)
                      .bufferCount(1)
                      .attribute(VertexAttribute::POSITION, 0, VertexBuffer::AttributeType::FLOAT3, offsetof(GaussianSplatVertex, position),
                                 sizeof(GaussianSplatVertex))
                      .attribute(VertexAttribute::CUSTOM0, 0, VertexBuffer::AttributeType::FLOAT4, offsetof(GaussianSplatVertex, corner),
                                 sizeof(GaussianSplatVertex))
                      .attribute(VertexAttribute::CUSTOM1, 0, VertexBuffer::AttributeType::FLOAT4, offsetof(GaussianSplatVertex, axis0),
                                 sizeof(GaussianSplatVertex))
                      .attribute(VertexAttribute::CUSTOM2, 0, VertexBuffer::AttributeType::FLOAT4, offsetof(GaussianSplatVertex, axis1),
                                 sizeof(GaussianSplatVertex))
                      .attribute(VertexAttribute::CUSTOM3, 0, VertexBuffer::AttributeType::FLOAT4, offsetof(GaussianSplatVertex, axis2),
                                 sizeof(GaussianSplatVertex))
                      .attribute(VertexAttribute::CUSTOM4, 0, VertexBuffer::AttributeType::FLOAT4, offsetof(GaussianSplatVertex, color),
                                 sizeof(GaussianSplatVertex))
                      .build(*_engine);
  _vertexBuffer->setBufferAt(*_engine, 0,
                             VertexBuffer::BufferDescriptor(vertices, vertexCount * sizeof(GaussianSplatVertex), freeVertexBuffer));

  _indexBuffer = IndexBuffer::Builder().indexCount(indexCount).bufferType(IndexBuffer::IndexType::UINT).build(*_engine);
  _indexBuffer->setBuffer(*_engine, IndexBuffer::BufferDescriptor(indices, indexCount * sizeof(uint32_t), freeIndexBuffer));

  _material = createMaterial(materialBuffer);
  _materialInstance = _material->createInstance();
  _materialInstance->setParameter("cameraPosition", float3({0.0f, 0.0f, 0.0f}));
  _materialInstance->setParameter("cameraRight", float3({1.0f, 0.0f, 0.0f}));
  _materialInstance->setParameter("cameraUp", float3({0.0f, 1.0f, 0.0f}));
  _materialInstance->setParameter("cameraForward", float3({0.0f, 0.0f, -1.0f}));
  _materialInstance->setParameter("renderSize", float2({1.0f, 1.0f}));
  applyRenderOptions();

  RenderableManager::Builder builder(1);
  const RenderableManager::Builder::Result result =
      builder.boundingBox(_boundingBox)
          .material(0, _materialInstance)
          .geometry(0, RenderableManager::PrimitiveType::TRIANGLES, _vertexBuffer, _indexBuffer, 0, indexCount)
          .culling(false)
          .castShadows(false)
          .receiveShadows(false)
          .build(*_engine, _entity);

  if (result != RenderableManager::Builder::Result::Success) {
    throw std::runtime_error("Failed to build Gaussian splat renderable");
  }

  Logger::log(TAG, "Loaded SPZ cloud: version=%d points=%d rendered=%d shDegree=%d", cloud.version, _pointCount, _renderedPointCount,
              cloud.shDegree);
}

void GaussianSplatWrapper::loadHybridMethods() {
  registerHybridMethod("getEntity", &GaussianSplatWrapper::getEntity, this);
  registerHybridMethod("getBoundingBox", &GaussianSplatWrapper::getBoundingBox, this);
  registerHybridMethod("setCameraView", &GaussianSplatWrapper::setCameraView, this);
  registerHybridMethod("setRenderSize", &GaussianSplatWrapper::setRenderSize, this);
  registerHybridMethod("setRenderOptions", &GaussianSplatWrapper::setRenderOptions, this);
  registerHybridMethod("sortByView", &GaussianSplatWrapper::sortByView, this);
  registerHybridGetter("pointCount", &GaussianSplatWrapper::getPointCount, this);
  registerHybridGetter("renderedPointCount", &GaussianSplatWrapper::getRenderedPointCount, this);
  registerHybridGetter("supportsRenderOptions", &GaussianSplatWrapper::getSupportsRenderOptions, this);
}

std::shared_ptr<EntityWrapper> GaussianSplatWrapper::getEntity() {
  return std::make_shared<EntityWrapper>(pointee()->getEntity());
}

std::shared_ptr<BoxWrapper> GaussianSplatWrapper::getBoundingBox() {
  return std::make_shared<BoxWrapper>(pointee()->getBoundingBox());
}

int GaussianSplatWrapper::getPointCount() {
  return pointee()->getPointCount();
}

int GaussianSplatWrapper::getRenderedPointCount() {
  return pointee()->getRenderedPointCount();
}

void GaussianSplatWrapper::setCameraView(std::vector<double> cameraPosition, std::vector<double> cameraRight, std::vector<double> cameraUp,
                                         std::vector<double> cameraForward) {
  pointee()->setCameraView(cameraPosition, cameraRight, cameraUp, cameraForward);
}

void GaussianSplatWrapper::setRenderSize(double width, double height) {
  pointee()->setRenderSize(width, height);
}

void GaussianSplatWrapper::setRenderOptions(std::optional<double> maxStdDev, std::optional<double> minPixelRadius,
                                            std::optional<double> maxPixelRadius, std::optional<double> preBlurAmount,
                                            std::optional<double> blurAmount, std::optional<double> minAlpha,
                                            std::optional<double> alphaGain, std::optional<double> focalAdjustment,
                                            std::optional<double> falloffGain, std::optional<double> highAlphaMax,
                                            std::optional<double> highAlphaStdDevBoost, std::optional<double> clipXY) {
  pointee()->setRenderOptions(maxStdDev, minPixelRadius, maxPixelRadius, preBlurAmount, blurAmount, minAlpha, alphaGain, focalAdjustment,
                              falloffGain, highAlphaMax, highAlphaStdDevBoost, clipXY);
}

void GaussianSplatWrapper::sortByView(std::vector<double> cameraPosition, std::vector<double> cameraTarget) {
  pointee()->sortByView(cameraPosition, cameraTarget);
}

bool GaussianSplatWrapper::getSupportsRenderOptions() {
  return pointee()->supportsRenderOptions();
}

} // namespace margelo
