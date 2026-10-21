import { describe, expect, it } from 'vitest';
import { getPanelBounds, type Rectangle } from '../electron/panel-position';

const display = { x: 0, y: 0, width: 1920, height: 1080 };
const workArea = { ...display, height: 1040 };

function contains(area: Rectangle, panel: Rectangle): void {
  expect(panel.width).toBeGreaterThan(0);
  expect(panel.height).toBeGreaterThan(0);
  expect(panel.x).toBeGreaterThanOrEqual(area.x);
  expect(panel.y).toBeGreaterThanOrEqual(area.y);
  expect(panel.x + panel.width).toBeLessThanOrEqual(area.x + area.width);
  expect(panel.y + panel.height).toBeLessThanOrEqual(area.y + area.height);
}

describe('tray panel placement', () => {
  it('opens above the bottom tray icon on the same screen, near its right edge', () => {
    const tray = { x: 1800, y: 1048, width: 24, height: 24 };
    const panel = getPanelBounds({ workArea, displayBounds: display, point: { x: 1812, y: 1060 }, trayBounds: tray, platform: 'win32' });
    expect(panel).toEqual({ x: 1364, y: 288, width: 460, height: 740 });
    expect(panel.x + panel.width).toBe(tray.x + tray.width);
    expect(panel.y + panel.height).toBeLessThan(tray.y);
    contains(workArea, panel);
  });

  it('opens below the macOS menu-bar icon', () => {
    const area = { x: 0, y: 24, width: 1440, height: 876 };
    const tray = { x: 1310, y: 0, width: 24, height: 24 };
    const panel = getPanelBounds({ workArea: area, displayBounds: { ...area, y: 0, height: 900 }, point: { x: 1322, y: 12 }, trayBounds: tray, platform: 'darwin' });
    expect(panel).toEqual({ x: 874, y: 36, width: 460, height: 740 });
    contains(area, panel);
  });

  it.each([
    { side: 'left', area: { x: 48, y: 0, width: 1872, height: 1080 }, tray: { x: 8, y: 900, width: 24, height: 24 }, x: 60 },
    { side: 'right', area: { x: 0, y: 0, width: 1872, height: 1080 }, tray: { x: 1880, y: 900, width: 24, height: 24 }, x: 1400 },
  ])('opens inward from a $side taskbar', ({ area, tray, x }) => {
    const panel = getPanelBounds({ workArea: area, displayBounds: display, point: { x: tray.x + 12, y: tray.y + 12 }, trayBounds: tray, platform: 'win32' });
    expect(panel.x).toBe(x);
    expect(panel.y).toBe(184);
    contains(area, panel);
  });

  it.each([
    { side: 'left', tray: { x: 8, y: 900, width: 24, height: 24 }, x: 44 },
    { side: 'right', tray: { x: 1880, y: 900, width: 24, height: 24 }, x: 1408 },
  ])('recognizes an auto-hidden $side taskbar without a reserved work-area strip', ({ tray, x }) => {
    const panel = getPanelBounds({ workArea: display, displayBounds: display, point: { x: tray.x + 12, y: tray.y + 12 }, trayBounds: tray, platform: 'win32' });
    expect(panel.x).toBe(x);
    expect(panel.y).toBe(184);
    contains(display, panel);
  });

  it.each([
    { side: 'right', tray: { x: 1760, y: 900, width: 24, height: 24 }, x: 1324 },
    { side: 'left', tray: { x: 96, y: 900, width: 24, height: 24 }, x: 96 },
  ])('keeps an overflow-tray popup beside the click on the $side half', ({ tray, x }) => {
    const panel = getPanelBounds({ workArea, displayBounds: display, point: { x: tray.x + 12, y: tray.y + 12 }, trayBounds: tray, platform: 'win32' });
    expect(panel).toEqual({ x, y: 148, width: 460, height: 740 });
    contains(workArea, panel);
  });

  it('handles a monitor left of the primary with negative coordinates', () => {
    const area = { x: -1920, y: 0, width: 1920, height: 1040 };
    const panel = getPanelBounds({ workArea: area, displayBounds: { ...area, height: 1080 }, point: { x: -68, y: 1060 }, trayBounds: { x: -80, y: 1048, width: 24, height: 24 }, platform: 'win32' });
    expect(panel).toEqual({ x: -516, y: 288, width: 460, height: 740 });
    contains(area, panel);
  });

  it('handles a monitor above the primary', () => {
    const area = { x: 0, y: -1176, width: 1920, height: 1176 };
    const panel = getPanelBounds({ workArea: area, displayBounds: { ...area, y: -1200, height: 1200 }, point: { x: 1812, y: -1188 }, trayBounds: { x: 1800, y: -1200, width: 24, height: 24 }, platform: 'darwin' });
    expect(panel).toEqual({ x: 1364, y: -1164, width: 460, height: 740 });
    contains(area, panel);
  });

  it('uses DIP dimensions directly on a scaled secondary monitor', () => {
    const area = { x: 1920, y: 0, width: 1280, height: 688 };
    const panel = getPanelBounds({ workArea: area, displayBounds: { ...area, height: 720 }, point: { x: 3160, y: 702 }, trayBounds: { x: 3152, y: 694, width: 16, height: 16 }, platform: 'win32' });
    expect(panel).toEqual({ x: 2708, y: 12, width: 460, height: 664 });
    contains(area, panel);
  });

  it.each([
    undefined,
    { x: 0, y: 0, width: 0, height: 0 },
    { x: 1800, y: 1048, width: -24, height: 24 },
    { x: 1800, y: Number.NaN, width: 24, height: 24 },
    { x: -80, y: 1048, width: 24, height: 24 },
    { x: 10, y: 1048, width: 24, height: 24 },
  ])('ignores absent, invalid, other-display, or stale tray bounds: %o', (trayBounds) => {
    const panel = getPanelBounds({ workArea, displayBounds: display, point: { x: 1812, y: 1060 }, trayBounds, platform: 'win32' });
    expect(panel).toEqual({ x: 1448, y: 288, width: 460, height: 740 });
  });

  it('falls back to the top right on macOS without valid menu-bar bounds', () => {
    const area = { x: 0, y: 24, width: 1440, height: 876 };
    const panel = getPanelBounds({ workArea: area, displayBounds: { ...area, y: 0, height: 900 }, point: { x: 800, y: 400 }, platform: 'darwin' });
    expect(panel).toEqual({ x: 968, y: 36, width: 460, height: 740 });
  });

  it.each([
    { x: 10, y: 20, width: 320, height: 240 },
    { x: -10, y: -20, width: 12, height: 10 },
    { x: 0, y: 0, width: 1, height: 1 },
  ])('fits a small work area without negative sizes: %o', (area) => {
    const panel = getPanelBounds({ workArea: area, displayBounds: area, point: { x: area.x, y: area.y }, platform: 'win32' });
    contains(area, panel);
    expect(panel.width).toBeLessThanOrEqual(460);
    expect(panel.height).toBeLessThanOrEqual(740);
  });
});
