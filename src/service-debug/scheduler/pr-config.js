function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function normalizePrObjects(value) {
  if (!Array.isArray(value)) return [];
  return value.map((pr) => {
    const source = asObject(pr);
    return {
      ten: typeof source.ten === "string" ? source.ten : "",
      idZalo: source.idZalo !== undefined && source.idZalo !== null ? String(source.idZalo) : "-1",
      noiDung: typeof source.noiDung === "string" ? source.noiDung : "",
      hinhAnh: Array.isArray(source.hinhAnh) ? source.hinhAnh : [],
      video: Array.isArray(source.video) ? source.video : [],
      link: asObject(source.link),
      thoiGianGui: Array.isArray(source.thoiGianGui) ? source.thoiGianGui : [],
      customContent: asObject(source.customContent),
      isContentActive: typeof source.isContentActive === "boolean" ? source.isContentActive : true,
      isImageActive: typeof source.isImageActive === "boolean" ? source.isImageActive : true,
      isVideoActive: typeof source.isVideoActive === "boolean" ? source.isVideoActive : true,
      isCardActive: typeof source.isCardActive === "boolean" ? source.isCardActive : true,
    };
  });
}

export function normalizeWebPrConfig(config) {
  const source = asObject(config);
  return {
    ...source,
    prObjects: normalizePrObjects(source.prObjects),
    selectedGroups: asObject(source.selectedGroups),
    selectedFriends: asObject(source.selectedFriends),
  };
}
