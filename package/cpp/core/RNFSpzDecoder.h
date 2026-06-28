#pragma once

#include <cstddef>
#include <cstdint>
#include <vector>

namespace margelo {

struct DecodedSpzSplat {
  float position[3];
  float scale[3];
  float rotation[4];
  float color[4];
};

struct DecodedSpzCloud {
  int32_t numPoints = 0;
  int32_t shDegree = 0;
  int32_t version = 0;
  bool antialiased = false;
  std::vector<DecodedSpzSplat> splats;
};

class SpzDecoder {
public:
  static DecodedSpzCloud decodeLegacyGzip(const uint8_t* data, size_t size);
};

} // namespace margelo
