const EFFECT_PIPELINE_ORDER = [
  "removeBackground",
  "renderText",
  "renderTextVideo",
  "crop",
  "zoom",
  "rotateFlip",
  "pixelate",
  "roundCorners",
  "animation",
  "encode",
];

export function normalizeEffectPlan(request) {
  const effects = request?.effects ?? {};
  const source = request?.source ?? "media";
  const payload = request?.payload ?? {};

  const plan = {
    source,
    payload,
    steps: [],
    warnings: [],
    animation: {
      spin: Boolean(effects.spin),
      speed: typeof effects.speed === "number" ? effects.speed : null,
    },
    meta: {
      pixelSize: effects.pixel ?? null,
      rotate: typeof effects.rotate === "number" ? effects.rotate : 0,
      flipHorizontal: Boolean(effects.flipHorizontal ?? effects.fh),
      flipVertical: Boolean(effects.flipVertical ?? effects.fv),
      zoom: typeof effects.zoom === "number" ? effects.zoom : null,
      crop: Boolean(effects.cat),
      roundPercent: typeof effects.round === "number" ? effects.round : 0,
      removeBackground: Boolean(effects.xp),
    },
  };

  const isExplicitVideoUrl = typeof payload?.url === "string" && /\.(mp4|mov|avi|mkv|webm)($|\?)/i.test(payload.url);

  if (plan.meta.removeBackground) {
    if (source === "text" || source === "textvd") {
      plan.warnings.push("xp không áp dụng cho chữ tĩnh hoặc textvd");
      plan.meta.removeBackground = false;
    } else if (isExplicitVideoUrl) {
      plan.warnings.push("xp chỉ áp dụng cho sticker tĩnh hoặc ảnh AI");
      plan.meta.removeBackground = false;
    } else {
      plan.steps.push("removeBackground");
    }
  }

  if (source === "text") {
    plan.steps.push("renderText");
  } else if (source === "textvd") {
    plan.steps.push("renderTextVideo");
  }

  if (plan.meta.crop) {
    plan.steps.push("crop");
  }
  if (plan.meta.zoom !== null) {
    plan.steps.push("zoom");
  }
  if (plan.meta.rotate !== 0 || plan.meta.flipHorizontal || plan.meta.flipVertical) {
    plan.steps.push("rotateFlip");
  }
  if (plan.meta.pixelSize) {
    plan.steps.push("pixelate");
  }
  if (plan.meta.roundPercent > 0) {
    plan.steps.push("roundCorners");
  }

  if (plan.animation.spin || plan.animation.speed !== null) {
    plan.steps.push("animation");
  }

  plan.steps.push("encode");
  plan.steps = EFFECT_PIPELINE_ORDER.filter((step) => plan.steps.includes(step));
  return plan;
}

export function planEffectsForRequest(request) {
  return normalizeEffectPlan(request);
}

export const __test = { EFFECT_PIPELINE_ORDER };
