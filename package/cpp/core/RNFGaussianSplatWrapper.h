#pragma once

#include "RNFBoxWrapper.h"
#include "RNFFilamentBuffer.h"
#include "RNFSpzDecoder.h"
#include "core/utils/RNFEntityWrapper.h"
#include "jsi/RNFPointerHolder.h"
#include "threading/RNFDispatcher.h"

#include <filament/Box.h>
#include <filament/Engine.h>
#include <filament/IndexBuffer.h>
#include <filament/Material.h>
#include <filament/MaterialInstance.h>
#include <filament/Scene.h>
#include <filament/VertexBuffer.h>
#include <math/vec2.h>
#include <math/vec3.h>
#include <utils/Entity.h>

#include <cstddef>
#include <memory>
#include <optional>
#include <vector>

namespace margelo {

struct GaussianSplatWorldTransform {
  float metricScaleFactor = 1.0f;
  float groundPlaneOffset = 0.0f;
  bool flipY = false;
};

struct GaussianSplatRenderOptions {
  float maxStdDev = 2.828427f;
  float minPixelRadius = 0.0f;
  float maxPixelRadius = 512.0f;
  float preBlurAmount = 0.0f;
  float blurAmount = 0.3f;
  float minAlpha = 0.00196f;
  float alphaGain = 2.0f;
  float focalAdjustment = 1.0f;
  float falloffGain = 1.0f;
  float clipXY = 1.4f;
  float highAlphaMax = 5.0f;
  float highAlphaStdDevBoost = 0.7f;
};

class GaussianSplatResource {
public:
  GaussianSplatResource(std::shared_ptr<filament::Engine> engine, std::shared_ptr<Dispatcher> dispatcher,
                        std::shared_ptr<filament::Scene> scene, std::shared_ptr<FilamentBuffer> spzBuffer,
                        std::shared_ptr<FilamentBuffer> materialBuffer, std::optional<int> maxSplats, std::optional<double> splatScale,
                        std::optional<double> metricScaleFactor, std::optional<double> groundPlaneOffset, std::optional<bool> flipY);
  ~GaussianSplatResource();

  utils::Entity getEntity() const;
  filament::Box getBoundingBox() const;
  int getPointCount() const;
  int getRenderedPointCount() const;
  void setCameraView(std::vector<double> cameraPosition, std::vector<double> cameraRight, std::vector<double> cameraUp,
                     std::vector<double> cameraForward);
  void setRenderSize(double width, double height);
  void setRenderOptions(std::optional<double> maxStdDev, std::optional<double> minPixelRadius, std::optional<double> maxPixelRadius,
                        std::optional<double> preBlurAmount, std::optional<double> blurAmount, std::optional<double> minAlpha,
                        std::optional<double> alphaGain, std::optional<double> focalAdjustment, std::optional<double> falloffGain,
                        std::optional<double> highAlphaMax, std::optional<double> highAlphaStdDevBoost,
                        std::optional<double> clipXY);
  void sortByView(std::vector<double> cameraPosition, std::vector<double> cameraTarget);
  bool supportsRenderOptions() const;

  struct GaussianSplatVertex;

private:
  filament::Material* createMaterial(std::shared_ptr<FilamentBuffer> materialBuffer);
  void buildRenderable(const DecodedSpzCloud& cloud, std::shared_ptr<FilamentBuffer> materialBuffer, std::optional<int> maxSplats,
                       float splatScale, GaussianSplatWorldTransform worldTransform);
  void applyRenderOptions();

private:
  std::shared_ptr<filament::Engine> _engine;
  std::shared_ptr<Dispatcher> _dispatcher;
  std::shared_ptr<filament::Scene> _scene;
  utils::Entity _entity;
  filament::VertexBuffer* _vertexBuffer = nullptr;
  filament::IndexBuffer* _indexBuffer = nullptr;
  filament::Material* _material = nullptr;
  filament::MaterialInstance* _materialInstance = nullptr;
  filament::Box _boundingBox = {};
  std::vector<filament::math::float3> _splatCenters;
  uint32_t _indexCount = 0;
  int _pointCount = 0;
  int _renderedPointCount = 0;
  GaussianSplatRenderOptions _renderOptions = {};
};

class GaussianSplatWrapper : public PointerHolder<GaussianSplatResource> {
public:
  explicit GaussianSplatWrapper(std::shared_ptr<GaussianSplatResource> splat)
      : PointerHolder("GaussianSplatWrapper", splat) {}

  void loadHybridMethods() override;

private:
  std::shared_ptr<EntityWrapper> getEntity();
  std::shared_ptr<BoxWrapper> getBoundingBox();
  int getPointCount();
  int getRenderedPointCount();
  void setCameraView(std::vector<double> cameraPosition, std::vector<double> cameraRight, std::vector<double> cameraUp,
                     std::vector<double> cameraForward);
  void setRenderSize(double width, double height);
  void setRenderOptions(std::optional<double> maxStdDev, std::optional<double> minPixelRadius, std::optional<double> maxPixelRadius,
                        std::optional<double> preBlurAmount, std::optional<double> blurAmount, std::optional<double> minAlpha,
                        std::optional<double> alphaGain, std::optional<double> focalAdjustment, std::optional<double> falloffGain,
                        std::optional<double> highAlphaMax, std::optional<double> highAlphaStdDevBoost,
                        std::optional<double> clipXY);
  void sortByView(std::vector<double> cameraPosition, std::vector<double> cameraTarget);
  bool getSupportsRenderOptions();
};

} // namespace margelo
