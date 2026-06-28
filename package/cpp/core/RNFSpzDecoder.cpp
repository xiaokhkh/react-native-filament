#include "RNFSpzDecoder.h"

#include "RNFLogger.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>
#include <zlib.h>

namespace margelo {

namespace {

constexpr auto TAG = "SpzDecoder";
constexpr uint32_t NGSP_MAGIC = 0x5053474e;
constexpr uint8_t FLAG_ANTIALIASED = 0x1;
constexpr uint8_t FLAG_HAS_EXTENSIONS = 0x2;
constexpr float SH_C0 = 0.28209479177387814f;
constexpr float COLOR_SCALE = 0.15f;

struct LegacyPackedGaussiansHeader {
  uint32_t magic = NGSP_MAGIC;
  uint32_t version = 0;
  uint32_t numPoints = 0;
  uint8_t shDegree = 0;
  uint8_t fractionalBits = 0;
  uint8_t flags = 0;
  uint8_t reserved = 0;
};

static_assert(sizeof(LegacyPackedGaussiansHeader) == 16, "Legacy SPZ header must be 16 bytes");

int32_t dimForDegree(int32_t degree) {
  switch (degree) {
    case 0:
      return 0;
    case 1:
      return 3;
    case 2:
      return 8;
    case 3:
      return 15;
    case 4:
      return 24;
    default:
      return -1;
  }
}

bool decompressGzip(const uint8_t* compressed, size_t size, std::vector<uint8_t>* out) {
  z_stream stream = {};
  stream.next_in = const_cast<Bytef*>(compressed);
  stream.avail_in = static_cast<uInt>(size);

  if (inflateInit2(&stream, 16 | MAX_WBITS) != Z_OK) {
    return false;
  }

  std::vector<uint8_t> chunk(8192);
  out->clear();
  out->reserve(size * 2);

  bool success = false;
  while (true) {
    stream.next_out = chunk.data();
    stream.avail_out = static_cast<uInt>(chunk.size());

    const int result = inflate(&stream, Z_NO_FLUSH);
    if (result != Z_OK && result != Z_STREAM_END) {
      break;
    }

    out->insert(out->end(), chunk.data(), chunk.data() + chunk.size() - stream.avail_out);
    if (result == Z_STREAM_END) {
      success = true;
      break;
    }
  }

  inflateEnd(&stream);
  return success;
}

float halfToFloat(uint16_t h) {
  const uint32_t sign = (h >> 15) & 0x1;
  const uint32_t exponent = (h >> 10) & 0x1f;
  const uint32_t mantissa = h & 0x3ff;
  const float signMul = sign == 1 ? -1.0f : 1.0f;

  if (exponent == 0) {
    return signMul * std::pow(2.0f, -14.0f) * static_cast<float>(mantissa) / 1024.0f;
  }
  if (exponent == 31) {
    return mantissa != 0 ? std::numeric_limits<float>::quiet_NaN() : signMul * std::numeric_limits<float>::infinity();
  }
  return signMul * std::pow(2.0f, static_cast<float>(exponent) - 15.0f) *
         (1.0f + static_cast<float>(mantissa) / 1024.0f);
}

float decodeFixed24(const uint8_t* bytes, uint8_t fractionalBits) {
  int32_t fixed32 = bytes[0];
  fixed32 |= bytes[1] << 8;
  fixed32 |= bytes[2] << 16;
  fixed32 |= (fixed32 & 0x800000) ? 0xff000000 : 0;
  return static_cast<float>(fixed32) / static_cast<float>(1 << fractionalBits);
}

void decodeQuaternionFirstThree(float rotation[4], const uint8_t* bytes) {
  const float x = static_cast<float>(bytes[0]) / 127.5f - 1.0f;
  const float y = static_cast<float>(bytes[1]) / 127.5f - 1.0f;
  const float z = static_cast<float>(bytes[2]) / 127.5f - 1.0f;
  rotation[0] = x;
  rotation[1] = y;
  rotation[2] = z;
  rotation[3] = std::sqrt(std::max(0.0f, 1.0f - x * x - y * y - z * z));
}

void decodeQuaternionSmallestThree(float rotation[4], const uint8_t* bytes) {
  uint32_t packed = static_cast<uint32_t>(bytes[0]) | (static_cast<uint32_t>(bytes[1]) << 8) |
                    (static_cast<uint32_t>(bytes[2]) << 16) | (static_cast<uint32_t>(bytes[3]) << 24);
  constexpr uint32_t COMPONENT_MASK = (1u << 9u) - 1u;
  constexpr float SQRT_ONE_HALF = 0.7071067811865475f;

  const int largestIndex = static_cast<int>(packed >> 30);
  float sumSquares = 0.0f;
  for (int component = 3; component >= 0; --component) {
    if (component == largestIndex) {
      continue;
    }
    const uint32_t magnitude = packed & COMPONENT_MASK;
    const uint32_t negative = (packed >> 9u) & 0x1u;
    packed >>= 10u;

    float value = SQRT_ONE_HALF * static_cast<float>(magnitude) / static_cast<float>(COMPONENT_MASK);
    if (negative != 0) {
      value = -value;
    }
    rotation[component] = value;
    sumSquares += value * value;
  }
  rotation[largestIndex] = std::sqrt(std::max(0.0f, 1.0f - sumSquares));
}

float decodeColor(uint8_t packed) {
  const float sh0 = ((static_cast<float>(packed) / 255.0f) - 0.5f) / COLOR_SCALE;
  return 0.5f + SH_C0 * sh0;
}

} // namespace

DecodedSpzCloud SpzDecoder::decodeLegacyGzip(const uint8_t* data, size_t size) {
  if (data == nullptr || size < 2) {
    throw std::runtime_error("SPZ buffer is empty");
  }

  if (size >= 4) {
    uint32_t magic = 0;
    std::memcpy(&magic, data, sizeof(magic));
    if (magic == NGSP_MAGIC) {
      throw std::runtime_error("SPZ v4/ZSTD is not supported by this mobile renderer yet");
    }
  }

  if (data[0] != 0x1f || data[1] != 0x8b) {
    throw std::runtime_error("SPZ buffer is not a legacy gzip SPZ file");
  }

  std::vector<uint8_t> decompressed;
  if (!decompressGzip(data, size, &decompressed)) {
    throw std::runtime_error("Failed to decompress gzip SPZ payload");
  }
  if (decompressed.size() < sizeof(LegacyPackedGaussiansHeader)) {
    throw std::runtime_error("SPZ payload is too small");
  }

  LegacyPackedGaussiansHeader header;
  std::memcpy(&header, decompressed.data(), sizeof(header));
  if (header.magic != NGSP_MAGIC) {
    throw std::runtime_error("SPZ legacy header magic is invalid");
  }
  if (header.version < 1 || header.version > 3) {
    throw std::runtime_error("Unsupported legacy SPZ version: " + std::to_string(header.version));
  }

  const int32_t shDim = dimForDegree(header.shDegree);
  if (shDim < 0) {
    throw std::runtime_error("Unsupported SPZ spherical-harmonics degree: " + std::to_string(header.shDegree));
  }
  if (header.numPoints == 0) {
    throw std::runtime_error("SPZ contains no splats");
  }

  const bool usesFloat16 = header.version == 1;
  const bool usesQuaternionSmallestThree = header.version >= 3;
  const size_t numPoints = header.numPoints;
  const size_t positionBytes = numPoints * 3 * (usesFloat16 ? 2 : 3);
  const size_t alphaBytes = numPoints;
  const size_t colorBytes = numPoints * 3;
  const size_t scaleBytes = numPoints * 3;
  const size_t rotationBytes = numPoints * (usesQuaternionSmallestThree ? 4 : 3);
  const size_t shBytes = numPoints * shDim * 3;
  const size_t expectedBytes =
      sizeof(LegacyPackedGaussiansHeader) + positionBytes + alphaBytes + colorBytes + scaleBytes + rotationBytes + shBytes;
  if (decompressed.size() < expectedBytes) {
    throw std::runtime_error("SPZ payload ended before all splat attributes were read");
  }

  const uint8_t* cursor = decompressed.data() + sizeof(LegacyPackedGaussiansHeader);
  const uint8_t* positions = cursor;
  cursor += positionBytes;
  const uint8_t* alphas = cursor;
  cursor += alphaBytes;
  const uint8_t* colors = cursor;
  cursor += colorBytes;
  const uint8_t* scales = cursor;
  cursor += scaleBytes;
  const uint8_t* rotations = cursor;
  cursor += rotationBytes;

  if ((header.flags & FLAG_HAS_EXTENSIONS) != 0) {
    Logger::log(TAG, "SPZ file has extensions; this renderer ignores extension metadata for now.");
  }

  DecodedSpzCloud cloud;
  cloud.numPoints = static_cast<int32_t>(numPoints);
  cloud.shDegree = header.shDegree;
  cloud.version = header.version;
  cloud.antialiased = (header.flags & FLAG_ANTIALIASED) != 0;
  cloud.splats.resize(numPoints);

  for (size_t i = 0; i < numPoints; ++i) {
    DecodedSpzSplat& splat = cloud.splats[i];
    if (usesFloat16) {
      const uint16_t* halfPositions = reinterpret_cast<const uint16_t*>(positions + i * 6);
      splat.position[0] = halfToFloat(halfPositions[0]);
      splat.position[1] = halfToFloat(halfPositions[1]);
      splat.position[2] = halfToFloat(halfPositions[2]);
    } else {
      const uint8_t* p = positions + i * 9;
      splat.position[0] = decodeFixed24(p + 0, header.fractionalBits);
      splat.position[1] = decodeFixed24(p + 3, header.fractionalBits);
      splat.position[2] = decodeFixed24(p + 6, header.fractionalBits);
    }

    const size_t base3 = i * 3;
    splat.scale[0] = static_cast<float>(scales[base3 + 0]) / 16.0f - 10.0f;
    splat.scale[1] = static_cast<float>(scales[base3 + 1]) / 16.0f - 10.0f;
    splat.scale[2] = static_cast<float>(scales[base3 + 2]) / 16.0f - 10.0f;
    if (usesQuaternionSmallestThree) {
      decodeQuaternionSmallestThree(splat.rotation, rotations + i * 4);
    } else {
      decodeQuaternionFirstThree(splat.rotation, rotations + i * 3);
    }
    splat.color[0] = decodeColor(colors[base3 + 0]);
    splat.color[1] = decodeColor(colors[base3 + 1]);
    splat.color[2] = decodeColor(colors[base3 + 2]);
    splat.color[3] = static_cast<float>(alphas[i]) / 255.0f;
  }

  return cloud;
}

} // namespace margelo
