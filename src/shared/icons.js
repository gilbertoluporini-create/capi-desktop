// Capi — set de ícones SVG (linha, profissional). Compartilhado janela + overlay.
// Uso: capiIcon("code", 20)  ->  string SVG.  avatarHTML(valor, 20) resolve ícone OU imagem.
const CAPI_ICONS = {
  // apps / linguagem
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  sparkles: '<path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7z"/><path d="M18 14l.7 1.8L20.5 16.5l-1.8.7L18 19l-.7-1.8L15.5 16.5l1.8-.7z"/>',
  robot: '<rect x="4" y="8" width="16" height="12" rx="2.5"/><circle cx="9" cy="14" r="1.2"/><circle cx="15" cy="14" r="1.2"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1.2"/>',
  message: '<path d="M21 11.5a8.5 8.5 0 0 1-12.3 7.6L3 21l1.9-5.7A8.5 8.5 0 1 1 21 11.5z"/>',
  // pessoas / coordenação
  person: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  hub: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.7" y1="10.7" x2="15.3" y2="6.3"/><line x1="8.7" y1="13.3" x2="15.3" y2="17.7"/>',
  compass: '<circle cx="12" cy="12" r="9"/><polygon points="16.2 7.8 11 11 7.8 16.2 13 13"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.6"/>',
  // formas / energia
  bolt: '<polygon points="13 2 4 14 12 14 11 22 20 10 12 10 13 2"/>',
  star: '<polygon points="12 2 14.6 8.6 21.6 9 16.2 13.6 18 20.4 12 16.6 6 20.4 7.8 13.6 2.4 9 9.4 8.6"/>',
  rocket: '<path d="M5 15c-1.5 1.2-2 5-2 5s3.8-.5 5-2c.8-.8.7-2 0-2.8a2 2 0 0 0-3 0z"/><path d="M13.5 15.5l-5-5A21 21 0 0 1 17 3c2 0 4 2 4 4a21 21 0 0 1-7.5 8.5z"/><circle cx="15" cy="9" r="1.3"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2.5"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><line x1="9" y1="2" x2="9" y2="5"/><line x1="15" y1="2" x2="15" y2="5"/><line x1="9" y1="19" x2="9" y2="22"/><line x1="15" y1="19" x2="15" y2="22"/><line x1="2" y1="9" x2="5" y2="9"/><line x1="2" y1="15" x2="5" y2="15"/><line x1="19" y1="9" x2="22" y2="9"/><line x1="19" y1="15" x2="22" y2="15"/>',
  globe: '<circle cx="12" cy="12" r="9"/><line x1="3" y1="12" x2="21" y2="12"/><path d="M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  chart: '<line x1="5" y1="20" x2="5" y2="11"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="19" y1="20" x2="19" y2="14"/>',
  flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/>',
  bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-5-7 5V4a1 1 0 0 1 1-1z"/>',
  // utilitários (botões)
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5L8 3h8l1.5 3H21a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/>',
  back: '<polyline points="15 18 9 12 15 6"/>',
  // navegação / settings (sidebar + botões)
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>',
  // status / controles
  check: '<polyline points="20 6 9 17 4 12"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  dot: '<circle cx="12" cy="12" r="6"/>',
  play: '<polygon points="7 4 19 12 7 20 7 4"/>',
  chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  pinFilled: '<polygon points="12 2 14.6 8.6 21.6 9 16.2 13.6 18 20.4 12 16.6 6 20.4 7.8 13.6 2.4 9 9.4 8.6" fill="currentColor" stroke="none"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/>',
};

function capiIcon(name, size) {
  const s = size || 20;
  const inner = CAPI_ICONS[name] || CAPI_ICONS.robot;
  return (
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
    `stroke-linejoin="round">${inner}</svg>`
  );
}

// resolve um "avatar":
//  - "capi:<nome>"  -> imagem da Capi em assets/avatares/<nome>.png (orquestrador/desktop/web/marca/qa/generico)
//  - "img:<caminho>" -> imagem em caminho explícito
//  - "<nome>"        -> ícone SVG do set
// (overlay.html e window.html ficam ambos em src/<dir>/, então ../../assets resolve nos dois)
function avatarHTML(value, size) {
  if (typeof value === "string" && value.startsWith("capi:")) {
    const name = value.slice(5).replace(/[^a-z0-9_-]/gi, "");
    return `<img class="av-img" src="../../assets/avatares/${name}.png" alt="" />`;
  }
  if (typeof value === "string" && value.startsWith("img:")) {
    return `<img class="av-img" src="${value.slice(4)}" alt="" />`;
  }
  return capiIcon(value, size);
}
