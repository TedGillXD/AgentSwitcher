export const MAX_SSE_FRAME_LENGTH = 8 * 1024 * 1024;
export const SSE_LINE_BREAK = /\r\n|\n|\r/;
export const SSE_FRAME_BREAK = /(?:\r\n|\n|\r(?!\n))(?:\r\n|\n|\r(?!\n))/;

export function parseSseFrame(frame: string): { value: unknown; other: string[]; dataStart: number; event?: string } | undefined {
  const data: string[] = [];
  const other: string[] = [];
  let dataStart = -1;
  let event: string | undefined;
  for (const line of frame.split(SSE_LINE_BREAK)) {
    if (line.startsWith('data:') || line === 'data') {
      if (dataStart === -1) dataStart = other.length;
      data.push(line.slice(5).replace(/^ /, ''));
    } else {
      if (line.startsWith('event:')) event = line.slice(6).replace(/^ /, '');
      other.push(line);
    }
  }
  if (dataStart === -1) return undefined;
  try { return { value: JSON.parse(data.join('\n')), other, dataStart, event }; }
  catch { return undefined; }
}
