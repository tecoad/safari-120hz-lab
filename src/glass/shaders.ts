// Glass GLSL. An original implementation that follows the author's model:
//  - shapes as SDFs (capsule / rounded rect) with a normal;
//  - polynomial "smooth union" to fuse two shapes (button ↔ panel, bar ↔ search);
//  - refraction: near the edge (bezel), the sample moves along the normal (inward);
//  - chromatic aberration: R and B move slightly less/more than G;
//  - frost: a blurred backdrop texture (downsample + separable Gaussian);
//  - finish: inner shade, sheen, bevel highlight (vertical light), hairline;
//  - Gaussian drop shadow.
// Everything is in CSS px: p = fragment position relative to the canvas corner.

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const COMMON = /* glsl */ `
uniform vec2 view;   // canvas size in CSS px
uniform float scale; // device px per CSS px

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const vec2 LIGHT_AXIS = vec2(0.0, -1.0); // light from above (y grows downward)

uniform float glassBevel;
uniform float glassShine;
uniform float glassGlint;
uniform float glassShinePower;
uniform float glassShade;
uniform float glassShadeStart;
uniform float glassShadePeak;
uniform float glassShadeEnd;
uniform float glassSideShade;
uniform float glassSideShadeStart;
uniform float glassSideShadeEnd;
uniform float glassSheen;
uniform float glassSheenDepth;
uniform float glassEdge;
uniform float glassEdgeCap;
uniform float glassEdgeWidth;

vec2 fragPoint() {
  return vec2(gl_FragCoord.x, view.y * scale - gl_FragCoord.y) / scale;
}

float coverOf(float d) {
  return clamp(0.5 - d * scale, 0.0, 1.0);
}

float softCover(float d, float feather) {
  return clamp((0.5 - d * scale) / (1.0 + feather * scale), 0.0, 1.0);
}

float capsule(vec2 p, vec2 halfSize, float radius) {
  vec2 q = abs(p) - (halfSize - radius);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

// Rounded rectangle with a normal (for refraction and lighting).
float shapeDistance(vec2 p, vec2 halfSize, float corner, out vec2 normal) {
  float radius = min(min(halfSize.x, halfSize.y), corner);
  vec2 q = abs(p) - (halfSize - radius);
  vec2 spine = max(q, 0.0);
  normal = vec2(0.0, 1.0);
  if (length(spine) > 0.0001) {
    normal = normalize(spine) * sign(p + vec2(0.00001));
  } else if (q.x > q.y) {
    normal = vec2(sign(p.x + 0.00001), 0.0);
  } else {
    normal = vec2(0.0, sign(p.y + 0.00001));
  }
  return length(spine) + min(max(q.x, q.y), 0.0) - radius;
}

float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 along = b - a;
  return length(p - a - along * clamp(dot(p - a, along) / dot(along, along), 0.0, 1.0));
}

// Approximation of the normal CDF (Gaussian edge).
float gaussianEdge(float x) {
  float a = abs(x) * 0.70710678;
  float t = 1.0 + a * (0.278393 + a * (0.230389 + a * (0.000972 + a * 0.078108)));
  float e = 1.0 - 1.0 / (t * t * t * t);
  return 0.5 * (1.0 + sign(x) * e);
}

float blurredCover(float d, float halfThickness, float sigma) {
  if (sigma <= 0.0) return clamp(0.5 - d * scale, 0.0, 1.0);
  float spread = sqrt(sigma * sigma + 0.083);
  return clamp(gaussianEdge(-d / spread) + gaussianEdge((2.0 * halfThickness + d) / spread) - 1.0, 0.0, 1.0);
}

vec3 saturateColor(vec3 c, float s) {
  float l = dot(c, LUMA);
  return clamp(vec3(l) + (c - vec3(l)) * s, 0.0, 1.0);
}

// Body tone: L' = lift + gain·L − curve·L², then re-saturate.
vec3 bodyTone(vec3 seen, vec3 lift, float gain, float curve, float saturation) {
  float luma = dot(seen, LUMA);
  vec3 toned = seen + lift + luma * (gain - curve * luma) - luma;
  return saturateColor(toned, saturation);
}

float bevelGleam(vec2 normal, float tilt, vec3 light) {
  vec3 surface = vec3(normal * sin(tilt), cos(tilt));
  return pow(max(dot(surface, light), 0.0), glassShinePower);
}

// Glass finish (inner shade, sheen, bevel highlight).
vec3 glassFinish(vec3 seen, vec2 normal, float within, float amount) {
  if (amount <= 0.0) return seen;
  float reach = max(max(glassShadeEnd, glassSideShadeEnd), max(glassBevel, glassSheenDepth));
  if (within >= reach) return seen;
  float facing = dot(normal, LIGHT_AXIS);
  float darken = 0.0;
  if (within < glassShadeEnd && facing > 0.0) {
    float bump = smoothstep(glassShadeStart, glassShadePeak, within) * (1.0 - smoothstep(glassShadePeak, glassShadeEnd, within));
    darken += glassShade * facing * bump;
  }
  if (within < glassSideShadeEnd) {
    float flank = 1.0 - abs(facing);
    darken += glassSideShade * flank * (1.0 - smoothstep(glassSideShadeStart, glassSideShadeEnd, within));
  }
  seen *= 1.0 - clamp(amount * darken, 0.0, 1.0);
  if (within < glassSheenDepth) {
    float entry = facing > 0.0 ? pow(facing, glassShinePower) : 0.0;
    float exitSide = facing < 0.0 ? pow(-facing, glassShinePower) : 0.0;
    float carried = 1.0 - clamp(within / max(glassSheenDepth, 0.001), 0.0, 1.0);
    float sheen = glassSheen * (entry + exitSide) * carried;
    seen += (1.0 - seen) * clamp(sheen * amount, 0.0, 1.0);
  }
  if (within < glassBevel) {
    float tilt = (1.0 - clamp(within / max(glassBevel, 0.001), 0.0, 1.0)) * 1.5707963;
    vec3 light = vec3(LIGHT_AXIS, 0.0);
    float gleam = glassShine * bevelGleam(normal, tilt, light) + glassGlint * bevelGleam(normal, tilt, vec3(-light.xy, 0.0));
    seen = min(seen + gleam * amount, vec3(1.0));
  }
  return seen;
}

// Hairline just outside the edge (subtractive): strongest on the sides.
float glassHairline(vec2 normal, float outside) {
  if (outside <= -0.5 / scale || outside >= max(glassEdgeWidth, 0.001)) return 0.0;
  float flank = 1.0 - abs(dot(normal, LIGHT_AXIS));
  float band = clamp(outside * scale + 0.5, 0.0, 1.0) * (1.0 - smoothstep(0.0, max(glassEdgeWidth, 0.001), outside));
  return clamp(glassEdge * mix(glassEdgeCap, 1.0, flank) * band, 0.0, 1.0);
}

float maxOf(vec3 v) {
  return max(v.r, max(v.g, v.b));
}
`

// ---------------------------------------------------------------------------
// Page scene: ring-buffer texture holding the DOM "re-render".
const SCENE_PAGE = /* glsl */ `
uniform sampler2D ringTex;
uniform vec2 ringSize;    // device px
uniform float ringScale;  // device px per CSS px of the ring
uniform vec2 scroll;      // document offset at the canvas origin
uniform float docWidth;
uniform vec3 ground;

// Live sources (the tab bar canvas, the meter canvases): pixels captured from
// other canvases, composited over the DOM re-render (with alpha, for
// transparent layers like the meter values).
// Sampler arrays only accept constant indices in GLSL ES 3.0, hence one
// sampler per source and the if-chain.
#define MAX_SRC 6
uniform sampler2D srcTex0;
uniform sampler2D srcTex1;
uniform sampler2D srcTex2;
uniform sampler2D srcTex3;
uniform sampler2D srcTex4;
uniform sampler2D srcTex5;
uniform vec4 srcCrop[MAX_SRC];   // document rect covered by the capture
uniform vec4 srcRect[MAX_SRC];   // document rect of the element (rounded clip)
uniform float srcRadius[MAX_SRC];
uniform int srcCount;

vec4 srcSample(int i, vec2 uv) {
  if (i == 0) return texture(srcTex0, uv);
  if (i == 1) return texture(srcTex1, uv);
  if (i == 2) return texture(srcTex2, uv);
  if (i == 3) return texture(srcTex3, uv);
  if (i == 4) return texture(srcTex4, uv);
  return texture(srcTex5, uv);
}

vec3 scene(vec2 p) {
  vec2 doc = p + scroll;
  vec3 base = ground;
  if (doc.x >= 0.0 && doc.x <= docWidth && doc.y >= 0.0) {
    float y = mod(doc.y * ringScale, ringSize.y);
    base = texture(ringTex, vec2(doc.x * ringScale / ringSize.x, y / ringSize.y)).rgb;
  }
  for (int i = 0; i < MAX_SRC; i++) {
    if (i >= srcCount) break;
    vec4 crop = srcCrop[i];
    if (crop.z <= 0.0) continue;
    vec4 r = srcRect[i];
    float rad = srcRadius[i];
    vec2 h = r.zw * 0.5;
    vec2 q = abs(doc - r.xy - h) - (h - rad);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
    if (d < 0.0) {
      vec4 c = srcSample(i, clamp((doc - crop.xy) / crop.zw, 0.0, 1.0));
      base = mix(base, c.rgb, c.a);
    }
  }
  return base;
}
`

// Tab bar demo scene: a procedural drifting grid.
const SCENE_GRID = /* glsl */ `
uniform vec3 ground;
uniform vec3 gridLine;
uniform float gridSpacing;
uniform vec2 gridPan;

vec3 scene(vec2 p) {
  vec2 q = p + gridPan;
  vec2 g = abs(fract(q / gridSpacing + 0.5) - 0.5) * gridSpacing;
  float dist = min(g.x, g.y);
  float line = clamp((0.5 - dist) * scale + 0.5, 0.0, 1.0);
  return mix(ground, gridLine, line);
}
`

// Downsample the scene into the frost region (averaged in gamma space).
const downsample = (sceneChunk: string) => /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform vec2 view;
uniform float scale;
${sceneChunk}
uniform vec2 passOrigin;
uniform vec2 passCell;
uniform float passGamma;
void main() {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    for (int j = 0; j < 2; j++) {
      vec2 at = passOrigin + (gl_FragCoord.xy - 0.5 + (vec2(float(i), float(j)) + 0.5) * 0.5) * passCell;
      sum += pow(scene(at), vec3(passGamma));
    }
  }
  outColor = vec4(sum * 0.25, 1.0);
}`

export const DOWNSAMPLE_PAGE_FS = downsample(SCENE_PAGE)
export const DOWNSAMPLE_GRID_FS = downsample(SCENE_GRID)

// Separable Gaussian (direction in texels).
export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D src;
uniform vec2 texSize;
uniform vec2 dir;
uniform float sigma;
uniform vec2 limit;
void main() {
  vec2 uv = gl_FragCoord.xy / texSize;
  vec2 lo = 0.5 / texSize;
  vec2 hi = limit - lo;
  if (sigma < 0.3) { outColor = texture(src, clamp(uv, lo, hi)); return; }
  int radius = int(min(ceil(sigma * 3.0), 24.0));
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int i = -24; i <= 24; i++) {
    if (i < -radius || i > radius) continue;
    float x = float(i);
    float w = exp(-0.5 * x * x / (sigma * sigma));
    sum += texture(src, clamp(uv + dir * x / texSize, lo, hi)).rgb * w;
    total += w;
  }
  outColor = vec4(sum / total, 1.0);
}`

// ---------------------------------------------------------------------------
// Page: scroll indicator (track) + menu (button ⊕ panel).
export const PAGE_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
${COMMON}
${SCENE_PAGE}

uniform float dark;

// page glass refraction
uniform float bezel;
uniform float edgeScale;
uniform float edgeFalloff;
uniform float aberration;

// --- track (reading-progress indicator)
uniform vec2 trackCenter;
uniform vec2 trackSize;
uniform float trackCorner;
uniform float trackAlpha;
uniform float trackSoft;
uniform float trackBend;
uniform vec4 groove;      // center xy, half width/height zw
uniform float fillEnd;
uniform vec4 fillColor;
uniform vec4 grooveColor;
uniform vec3 trackShadow; // opacity, sigma, offset

// --- menu: round button ⊕ panel
uniform vec2 panelCenter;
uniform vec2 panelSize;
uniform float panelCorner;
uniform vec2 buttonCenter;
uniform float buttonRadius;
uniform float mergeRadius;
uniform float bodyAlpha;
uniform vec3 bodyShadow;

// menu material: blur + saturation + veil
uniform sampler2D frostTex;
uniform vec2 frostOrigin;
uniform vec2 frostSize;
uniform vec2 frostUV;
uniform float frostGamma;
uniform float frostLive;
uniform vec3 veilColor;
uniform float veilAmount;
uniform float saturation;

// --- panel content (label texture: R = ink, G = separators)
uniform sampler2D labelTex;
uniform vec2 labelSize;
uniform vec2 contentAnchor;
uniform vec2 contentRestAnchor;
uniform float contentScale;
uniform float contentAlpha;
uniform float contentLod;
uniform float contentScroll;
uniform vec4 inkColor;
uniform vec4 lineColor;
uniform vec4 pillRect;
uniform float pillAlpha;
uniform vec4 pillColor;

// --- button icon
uniform float iconAlpha;
uniform float iconScale;
uniform vec4 iconColor;

float bodyDistance(vec2 p, out vec2 normal, out vec2 center, out float radius) {
  vec2 nButton = normalize(p - buttonCenter + vec2(0.0, 0.00001));
  float dButton = length(p - buttonCenter) - buttonRadius;
  if (panelSize.x <= 0.0) {
    normal = nButton; center = buttonCenter; radius = buttonRadius;
    return dButton;
  }
  vec2 nPanel;
  float dPanel = shapeDistance(p - panelCenter, panelSize * 0.5, panelCorner, nPanel);
  float k = max(mergeRadius, 0.001);
  float share = clamp(0.5 + 0.5 * (dButton - dPanel) / k, 0.0, 1.0);
  normal = normalize(mix(nButton, nPanel, share) + vec2(0.00001));
  center = mix(buttonCenter, panelCenter, share);
  radius = mix(buttonRadius, min(panelCorner, min(panelSize.x, panelSize.y) * 0.5), share);
  return mix(dButton, dPanel, share) - k * share * (1.0 - share);
}

float bodyDistanceOnly(vec2 p) {
  vec2 n; vec2 c; float r;
  return bodyDistance(p, n, c, r);
}

vec3 frostAt(vec2 p) {
  vec2 uv = (p - frostOrigin) / frostSize * frostUV;
  return pow(texture(frostTex, uv).rgb, vec3(1.0 / frostGamma));
}

// Refraction (G) and aberration (R, B) offsets.
void refractShifts(vec2 normal, float within, float radius, float bend, out vec2 sr, out vec2 sg, out vec2 sb) {
  float band = clamp(bezel, 1.0, max(radius, 1.0));
  float edge = 1.0 - clamp(within / band, 0.0, 1.0);
  float curve = pow(edge, edgeFalloff) * bend;
  float pull = radius * (edgeScale - 1.0) * curve;
  float spread = aberration * curve;
  sg = normal * pull;
  sr = sg * (1.0 - spread);
  sb = sg * (1.0 + spread);
}

vec4 trackInk(vec2 p, float sigma) {
  vec2 gh = groove.zw;
  if (gh.x <= 0.0) return vec4(0.0);
  float gr = min(gh.x, gh.y);
  float g = capsule(p - groove.xy, gh, gr);
  float leading = groove.x - gh.x;
  vec2 fh = vec2(max(fillEnd - leading, 0.0) * 0.5, gh.y);
  float f = fh.x > 0.0 ? max(g, capsule(p - vec2(leading + fh.x, groove.y), fh, min(fh.x, fh.y))) : 1.0;
  vec4 filled = vec4(fillColor.rgb * fillColor.a, fillColor.a) * blurredCover(f, gh.y, sigma);
  vec4 grooved = vec4(grooveColor.rgb * grooveColor.a, grooveColor.a) * blurredCover(g, gh.y, sigma);
  return filled + grooved * (1.0 - filled.a);
}

vec3 trackBody(vec2 p, vec2 normal, float d) {
  float within = max(-d, 0.0);
  float radius = min(trackSize.y * 0.5, trackCorner);
  vec2 sr; vec2 sg; vec2 sb;
  refractShifts(normal, within, radius, trackBend, sr, sg, sb);
  vec3 seen;
  if (trackSoft > 0.05) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      vec2 nudge = vec2(i < 2 ? -trackSoft : trackSoft, (i == 0 || i == 2) ? -trackSoft : trackSoft) * 0.7;
      acc += vec3(scene(p + sr + nudge).r, scene(p + sg + nudge).g, scene(p + sb + nudge).b);
    }
    seen = acc * 0.25;
  } else {
    seen = vec3(scene(p + sr).r, scene(p + sg).g, scene(p + sb).b);
  }
  seen = glassFinish(seen, normal, within, trackBend);
  vec4 ink = trackInk(p, trackSoft);
  return ink.rgb + seen * (1.0 - ink.a);
}

vec3 menuBody(vec2 p, vec2 normal, float d, float radius) {
  float within = max(-d, 0.0);
  vec2 sr; vec2 sg; vec2 sb;
  refractShifts(normal, within, radius, 1.0, sr, sg, sb);
  vec3 seen = frostLive > 0.5
    ? vec3(frostAt(p + sr).r, frostAt(p + sg).g, frostAt(p + sb).b)
    : vec3(scene(p + sr).r, scene(p + sg).g, scene(p + sb).b);
  seen = saturateColor(seen, saturation);
  seen = mix(seen, veilColor, veilAmount);
  return glassFinish(seen, normal, within, 1.0);
}

float listIcon(vec2 q) {
  float d = 1e5;
  for (int i = 0; i < 3; i++) {
    float y = -6.0 + 6.0 * float(i);
    d = min(d, length(q - vec2(-7.6, y)) - 1.6);
    d = min(d, segmentDistance(q, vec2(-2.6, y), vec2(8.6, y)) - 0.95);
  }
  return d;
}

vec3 panelContent(vec2 p, vec3 color, float within) {
  if (contentAlpha <= 0.0) return color;
  vec2 q = contentRestAnchor + (p - contentAnchor) / contentScale + vec2(0.0, contentScroll);
  float clip = smoothstep(0.0, 6.0, within) * contentAlpha;
  if (pillAlpha > 0.0) {
    float pr = min(pillRect.z, pillRect.w);
    float pd = capsule(q - pillRect.xy, pillRect.zw, pr) * contentScale;
    float pc = clamp(0.5 - pd * scale, 0.0, 1.0) * pillAlpha * pillColor.a * clip;
    color = mix(color, pillColor.rgb, pc);
  }
  if (q.x < 0.0 || q.y < 0.0 || q.x > labelSize.x || q.y > labelSize.y) return color;
  vec2 c = textureLod(labelTex, q / labelSize, contentLod).rg;
  color = mix(color, lineColor.rgb, clamp(c.g * lineColor.a * clip, 0.0, 1.0));
  color = mix(color, inkColor.rgb, clamp(c.r * inkColor.a * clip, 0.0, 1.0));
  return color;
}

void main() {
  vec2 p = fragPoint();
  vec4 acc = vec4(0.0);

  // ---- track layer
  if (trackAlpha > 0.0 && trackSize.x > 0.0) {
    vec2 tn;
    float td = shapeDistance(p - trackCenter, trackSize * 0.5, trackCorner, tn);
    float cover = softCover(td, trackSoft) * trackAlpha;
    float castD = capsule(p - trackCenter - vec2(0.0, trackShadow.z), trackSize * 0.5, min(trackSize.y * 0.5, trackCorner));
    float shade = trackShadow.x * trackAlpha * (1.0 - gaussianEdge(castD / max(trackShadow.y, 0.001)));
    float rim = glassHairline(tn, td) * trackAlpha * (glassEdgeWidth / (glassEdgeWidth + trackSoft));
    float darken = shade;
    if (rim > 0.0) {
      vec3 under = scene(p);
      vec3 h = min(vec3(rim), under) / max(under, vec3(0.004));
      darken = 1.0 - (1.0 - shade) * (1.0 - clamp(maxOf(h), 0.0, 1.0));
    }
    vec4 outside = vec4(0.0, 0.0, 0.0, darken);
    if (cover > 0.0) {
      vec3 body = trackBody(p, tn, td);
      acc = vec4(body * cover, cover) + outside * (1.0 - cover);
    } else {
      acc = outside;
    }
  }

  // ---- menu layer (button ⊕ panel)
  if (bodyAlpha > 0.0) {
    vec2 n; vec2 c; float r;
    float d = bodyDistance(p, n, c, r);
    float cover = coverOf(d) * bodyAlpha;
    float castD = bodyDistanceOnly(p - vec2(0.0, bodyShadow.z));
    float shade = bodyShadow.x * bodyAlpha * (1.0 - gaussianEdge(castD / max(bodyShadow.y, 0.001)));
    float rim = glassHairline(n, d) * bodyAlpha;
    float darken = shade;
    if (rim > 0.0) {
      vec3 under = scene(p);
      vec3 h = min(vec3(rim), under) / max(under, vec3(0.004));
      darken = 1.0 - (1.0 - shade) * (1.0 - clamp(maxOf(h), 0.0, 1.0));
    }
    vec4 layer = vec4(0.0, 0.0, 0.0, darken);
    if (cover > 0.0) {
      float within = max(-d, 0.0);
      vec3 body = menuBody(p, n, d, r);
      body = panelContent(p, body, within);
      if (iconAlpha > 0.0) {
        float id = listIcon((p - buttonCenter) / iconScale) * iconScale;
        float ic = clamp(0.5 - id * scale, 0.0, 1.0) * iconAlpha * iconColor.a;
        body = mix(body, iconColor.rgb, ic);
      }
      layer = vec4(body * cover, cover) + layer * (1.0 - cover);
    }
    acc = layer + acc * (1.0 - layer.a);
  }

  outColor = acc;
}`

// ---------------------------------------------------------------------------
// Tab bar: bar ⊕ search button, resting pill, magnifying lens.
export const DOCK_FS = /* glsl */ `#version 300 es
precision highp float;
out vec4 outColor;
${COMMON}
${SCENE_GRID}

uniform float dark;

uniform vec2 dockCenter;
uniform vec2 dockSize;
uniform float dockCorner;
uniform vec2 buttonCenter;
uniform vec2 buttonSize;
uniform float mergeRadius;
uniform vec2 dockTouch;
uniform float dockGlow;
uniform float buttonGlow;
uniform float dockBarLift;

uniform float barBezel;
uniform float barEdgeScale;
uniform float barEdgeFalloff;
uniform vec3 barLift;
uniform float barGain;
uniform float barCurve;
uniform float barSaturation;
uniform float glowFalloff;
uniform float glowReach;
uniform vec3 barShadow;

uniform sampler2D frostTex;
uniform vec2 frostOrigin;
uniform vec2 frostSize;
uniform vec2 frostUV;
uniform float frostGamma;
uniform float frostLive;

uniform vec2 pillCenter;
uniform vec2 pillSize;
uniform float pillAlpha;
uniform vec4 pillColor;
uniform float pillGradient;

uniform vec2 lensCenter;
uniform vec2 lensSize;
uniform float lensPresence;
uniform float lensStrength;
uniform vec2 centerScale;
uniform float edgeScale;
uniform float edgeFalloff;
uniform float bezel;
uniform float aberration;
uniform float fringeReach;
uniform float rimIntensity;
uniform vec3 lensDrop;

uniform sampler2D labelTex;
uniform vec2 labelSize;
uniform vec4 glyphColor;
uniform vec4 glyphSelected;
uniform vec2 dockRest;
uniform vec2 buttonRest;
uniform vec2 barGrow;
uniform vec2 buttonGrow;
uniform vec3 iconSplit;
uniform vec3 slots;
uniform float glyphLift;

struct Shape {
  float d;
  vec2 normal;
  vec2 center;
  float radius;
  vec2 touch;
  float glow;
  float share;
};

Shape navShape(vec2 at) {
  vec2 dockHalf = dockSize * 0.5;
  vec2 buttonHalf = buttonSize * 0.5;
  vec2 dn;
  vec2 bn;
  float dd = shapeDistance(at - dockCenter, dockHalf, dockCorner, dn);
  float bd = shapeDistance(at - buttonCenter, buttonHalf, 1e9, bn);
  float k = max(mergeRadius, 0.001);
  float share = clamp(0.5 + 0.5 * (bd - dd) / k, 0.0, 1.0);
  Shape s;
  s.d = mix(bd, dd, share) - mergeRadius * share * (1.0 - share);
  vec2 blended = mix(bn, dn, share);
  s.normal = length(blended) > 0.0001 ? normalize(blended) : dn;
  s.center = mix(buttonCenter, dockCenter, share);
  vec2 halfSize = mix(buttonHalf, dockHalf, share);
  s.radius = min(min(halfSize.x, halfSize.y), mix(min(buttonHalf.x, buttonHalf.y), dockCorner, share));
  s.touch = mix(buttonCenter, dockTouch, share);
  s.glow = mix(buttonGlow, dockGlow, share);
  s.share = share;
  return s;
}

float barCast(vec2 at) {
  vec2 lift = vec2(0.0, barShadow.z);
  vec2 dh = dockSize * 0.5;
  vec2 bh = buttonSize * 0.5;
  float dc = capsule(at - dockCenter - lift, dh, min(min(dh.x, dh.y), dockCorner));
  float bc = capsule(at - buttonCenter - lift, bh, min(bh.x, bh.y));
  float k = max(mergeRadius, 0.001);
  float share = clamp(0.5 + 0.5 * (bc - dc) / k, 0.0, 1.0);
  float d = mix(bc, dc, share) - mergeRadius * share * (1.0 - share);
  return barShadow.x * (1.0 - gaussianEdge(d / max(barShadow.y, 0.001)));
}

vec3 frostAt(vec2 p) {
  vec2 uv = (p - frostOrigin) / frostSize * frostUV;
  return pow(texture(frostTex, uv).rgb, vec3(1.0 / frostGamma));
}

vec3 glassBody(vec2 at, Shape s) {
  float within = max(-s.d, 0.0);
  float band = clamp(barBezel, 1.0, max(s.radius, 1.0));
  float edge = 1.0 - clamp(within / band, 0.0, 1.0);
  float curve = pow(edge, barEdgeFalloff);
  vec2 base = at + s.normal * s.radius * (barEdgeScale - 1.0) * curve;
  vec3 seen = frostLive > 0.5 ? frostAt(base) : scene(base);
  seen = bodyTone(seen, barLift, barGain, barCurve, barSaturation);
  if (s.glow > 0.0) {
    float away = clamp(length(at - s.touch) / max(glowReach, 1.0), 0.0, 1.0);
    seen = min(seen * (1.0 + s.glow * (1.0 - glowFalloff * away)), vec3(1.0));
  }
  seen = min(seen + dockBarLift * s.share, vec3(1.0));
  return glassFinish(seen, s.normal, within, 1.0);
}

vec4 barGround(vec2 at, Shape s) {
  float cover = coverOf(s.d);
  vec3 behind = vec3(0.0);
  if (cover < 1.0) {
    behind = scene(at);
    behind *= 1.0 - barCast(at) * (1.0 - cover);
    behind = max(behind - glassHairline(s.normal, s.d), vec3(0.0));
  }
  if (cover <= 0.0) return vec4(behind, 1.0);
  vec3 seen = glassBody(at, s);
  return vec4(cover < 1.0 ? mix(behind, seen, cover) : seen, 1.0);
}

float dockCover(vec2 at) {
  vec2 h = dockSize * 0.5;
  return coverOf(capsule(at - dockCenter, h, min(min(h.x, h.y), dockCorner)));
}

vec4 pillAt(vec2 at) {
  if (pillAlpha <= 0.0 || pillSize.x <= 0.0) return vec4(0.0);
  float clip = dockCover(at);
  if (clip <= 0.0) return vec4(0.0);
  vec2 h = pillSize * 0.5;
  float d = capsule(at - pillCenter, h, min(h.x, h.y));
  float outer = coverOf(d);
  if (outer <= 0.0) return vec4(0.0);
  float lift = 1.0 + pillGradient * clamp(-(at.y - pillCenter.y) / max(h.y, 1.0), -1.0, 1.0);
  return vec4(pillColor.rgb, 1.0) * pillColor.a * outer * lift * pillAlpha * clip;
}

vec4 overPill(vec4 ground, vec2 at) {
  vec4 pill = pillAt(at);
  return pill + ground * (1.0 - pill.a);
}

float pillCoverage(vec2 at) {
  if (pillSize.x <= 0.0 || pillAlpha <= 0.0) return 0.0;
  vec2 h = pillSize * 0.5;
  return coverOf(capsule(at - pillCenter, h, min(h.x, h.y)));
}

vec4 glyphAt(vec2 spot, float inside) {
  vec2 uv = spot / labelSize;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  vec2 c = textureLod(labelTex, uv, 0.0).rg;
  vec4 base = vec4(glyphColor.rgb, 1.0) * glyphColor.a * c.r;
  vec4 rev = vec4(glyphSelected.rgb, 1.0) * glyphSelected.a * c.g;
  return mix(base, rev, inside);
}

bool besideButton(vec2 at) {
  return dot(at, iconSplit.xy) > iconSplit.z;
}

vec4 iconsAt(vec2 at, float inside, float shapeD) {
  if (shapeD > 1.0) return vec4(0.0);
  bool beside = besideButton(at);
  vec2 anchor = beside ? buttonCenter : dockCenter;
  vec2 grown = beside ? buttonGrow : barGrow;
  vec2 rest = beside ? buttonRest : dockRest;
  return glyphAt(rest + (at - anchor) / grown, inside) * coverOf(shapeD);
}

// Filled glyphs under the lens, magnified by glyphLift.
vec4 filledAt(vec2 at) {
  bool beside = besideButton(at);
  vec2 anchor = beside ? buttonCenter : dockCenter;
  vec2 grown = beside ? buttonGrow : barGrow;
  vec2 rest = beside ? buttonRest : dockRest;
  vec2 spot = rest + (at - anchor) / grown;
  if (beside) return glyphAt(spot, 1.0);
  float lift = mix(1.0, glyphLift, lensStrength);
  float nearest = floor((spot.x - slots.x) / slots.y);
  vec4 result = vec4(0.0);
  for (int i = 0; i < 2; i++) {
    float index = nearest + float(i);
    if (index < 0.0 || index > slots.z - 1.0) continue;
    vec2 item = vec2(slots.x + index * slots.y, rest.y);
    vec2 local = (spot - item) / lift;
    if (abs(local.x) > slots.y * 0.5) continue;
    vec4 g = glyphAt(item + local, 1.0);
    result = g + result * (1.0 - g.a);
  }
  return result;
}

vec3 lensSource(vec2 at, vec2 glyphPoint) {
  Shape s = navShape(at);
  vec4 ground = overPill(barGround(at, s), at);
  vec4 filled = filledAt(glyphPoint);
  return filled.rgb + ground.rgb * (1.0 - filled.a);
}

vec3 navColor(vec2 here) {
  Shape shape = navShape(here);
  vec2 halfSize = lensSize * 0.5;
  vec2 p = here - lensCenter;
  float radius = min(halfSize.x, halfSize.y);
  vec2 q = abs(p) - (halfSize - radius);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  float coverage = (radius > 0.0 && lensPresence > 0.0) ? coverOf(d) : 0.0;
  bool lensFull = coverage >= 1.0;
  vec3 shaded = vec3(0.0);
  if (!lensFull) {
    vec4 plainGround = overPill(barGround(here, shape), here);
    vec4 icons = iconsAt(here, pillCoverage(here), shape.d) * (1.0 - coverage);
    vec3 plain = icons.rgb + plainGround.rgb * (1.0 - icons.a);
    shaded = plain;
    if (radius > 0.0 && lensDrop.x > 0.0 && lensPresence > 0.0) {
      vec2 dropped = abs(p - vec2(0.0, lensDrop.z)) - (halfSize - radius);
      float dropD = length(max(dropped, 0.0)) + min(max(dropped.x, dropped.y), 0.0) - radius;
      float sigma = max(lensDrop.y, 0.001);
      float ring = gaussianEdge((dropD + lensDrop.y * 0.9) / sigma) - gaussianEdge(dropD / sigma);
      shaded = plain * (1.0 - lensDrop.x * lensPresence * ring * (1.0 - coverage));
    }
    if (coverage <= 0.0) return shaded;
  }
  float bend = lensStrength;
  float within = max(-d, 0.0);
  vec2 spine = max(q, 0.0);
  vec2 normal = vec2(0.0, 1.0);
  if (length(spine) > 0.0001) normal = normalize(spine) * sign(p + vec2(0.00001));
  else if (q.x > q.y) normal = vec2(sign(p.x + 0.00001), 0.0);
  else normal = vec2(0.0, sign(p.y + 0.00001));
  float band = clamp(bezel, 1.0, max(radius, 1.0));
  float edge = 1.0 - clamp(within / band, 0.0, 1.0);
  float curve = edge > 0.0 ? pow(edge, edgeFalloff) : 0.0;
  vec2 inner = p * mix(vec2(1.0), 1.0 / centerScale, bend);
  float pull = band * (edgeScale - 1.0) * curve * bend;
  float split = aberration * fringeReach * curve * bend;
  vec2 sg = normal * pull;
  vec2 sr = sg - normal * split;
  vec2 sb = sg + normal * split;
  vec3 ground;
  if (split > 0.001) {
    ground = vec3(
      lensSource(lensCenter + inner + sr, lensCenter + p + sr).r,
      lensSource(lensCenter + inner + sg, lensCenter + p + sg).g,
      lensSource(lensCenter + inner + sb, lensCenter + p + sb).b);
  } else {
    ground = lensSource(lensCenter + inner + sg, lensCenter + p + sg);
  }
  float lineAlpha = (1.0 - smoothstep(0.0, 0.9, within)) * 0.45 * rimIntensity * smoothstep(0.0, 0.35, bend);
  vec3 edgeColor = mix(vec3(0.7, 0.7, 0.72), vec3(0.75, 0.75, 0.78), dark);
  vec3 lens = glassFinish(ground, normal, within, smoothstep(0.0, 0.35, bend));
  lens = lens * (1.0 - lineAlpha) + edgeColor * lineAlpha;
  return lensFull ? lens : mix(shaded, lens, coverage);
}

void main() {
  outColor = vec4(navColor(fragPoint()), 1.0);
}`
