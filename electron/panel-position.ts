export interface Point { x: number; y: number }
export interface Rectangle extends Point { width: number; height: number }

interface PanelPositionOptions {
  workArea: Rectangle;
  displayBounds: Rectangle;
  /** Captured at the tray click, in Electron device-independent pixels. */
  point: Point;
  trayBounds?: Rectangle;
  platform: string;
}

const GAP = 12;

function usableTray(tray: Rectangle | undefined, point: Point, display: Rectangle): tray is Rectangle {
  if (!tray || ![tray.x, tray.y, tray.width, tray.height].every(Number.isFinite) ||
      tray.width <= 0 || tray.height <= 0 || tray.width > 128 || tray.height > 128) return false;
  const center = { x: tray.x + tray.width / 2, y: tray.y + tray.height / 2 };
  if (center.x < display.x || center.x >= display.x + display.width ||
      center.y < display.y || center.y >= display.y + display.height) return false;
  // An overflow tray may disappear before getBounds runs. Do not anchor to an
  // unrelated/stale icon, even when it still belongs to the same display.
  const dx = Math.max(tray.x - point.x, 0, point.x - (tray.x + tray.width));
  const dy = Math.max(tray.y - point.y, 0, point.y - (tray.y + tray.height));
  return Math.hypot(dx, dy) <= 96;
}

/** Position a tray panel on a display already selected using the click point. */
export function getPanelBounds({ workArea: area, displayBounds: display, point, trayBounds: tray, platform }: PanelPositionOptions): Rectangle {
  // Extremely small work areas still produce positive dimensions contained in
  // that work area; ordinary screens retain a 12 DIP margin on every edge.
  const marginX = Math.min(GAP, Math.max(0, Math.floor((area.width - 1) / 2)));
  const marginY = Math.min(GAP, Math.max(0, Math.floor((area.height - 1) / 2)));
  const width = Math.min(460, Math.max(1, area.width - 2 * marginX));
  const height = Math.min(740, Math.max(1, area.height - 2 * marginY));
  const left = area.x + marginX;
  const right = area.x + area.width - marginX - width;
  const top = area.y + marginY;
  const bottom = area.y + area.height - marginY - height;
  let x = right;
  let y = platform === 'darwin' ? top : bottom;

  if (usableTray(tray, point, display)) {
    const center = { x: tray.x + tray.width / 2, y: tray.y + tray.height / 2 };
    const lowerHalf = point.y >= area.y + area.height / 2;
    const rightHalf = point.x >= area.x + area.width / 2;
    x = rightHalf ? tray.x + tray.width - width : tray.x;
    y = lowerHalf ? tray.y - GAP - height : tray.y + tray.height + GAP;

    // Reserved taskbar/menu-bar regions identify the correct inward direction,
    // including vertical taskbars. Overflow icons inside the work area keep the
    // nearest-side alignment above, then the final clamp keeps the panel visible.
    const distances = [
      { edge: 'left', distance: center.x - display.x },
      { edge: 'right', distance: display.x + display.width - center.x },
      { edge: 'top', distance: center.y - display.y },
      { edge: 'bottom', distance: display.y + display.height - center.y },
    ];
    const nearest = distances.reduce((a, b) => a.distance <= b.distance ? a : b);
    const edge = center.x < area.x ? 'left' : center.x >= area.x + area.width ? 'right' :
      center.y < area.y ? 'top' : center.y >= area.y + area.height ? 'bottom' :
      nearest.distance <= 48 ? nearest.edge : null;
    if (edge === 'left') {
      x = tray.x + tray.width + GAP;
      y = lowerHalf ? tray.y + tray.height - height : tray.y;
    } else if (edge === 'right') {
      x = tray.x - GAP - width;
      y = lowerHalf ? tray.y + tray.height - height : tray.y;
    } else if (edge === 'top') {
      y = tray.y + tray.height + GAP;
    } else if (edge === 'bottom') {
      y = tray.y - GAP - height;
    }
  }

  return { x: Math.round(Math.max(left, Math.min(right, x))), y: Math.round(Math.max(top, Math.min(bottom, y))), width, height };
}
