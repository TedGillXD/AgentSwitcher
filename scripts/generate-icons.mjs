import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// Dependency-free rasterization of the app's two opposing switch chevrons.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
function lineDistance(x, y, x1, y1, x2, y2) {
  const t = Math.max(0, Math.min(1, ((x-x1)*(x2-x1)+(y-y1)*(y2-y1))/((x2-x1)**2+(y2-y1)**2)));
  return Math.hypot(x-x1-t*(x2-x1), y-y1-t*(y2-y1));
}
function png(size, template = false) {
  const data = Buffer.alloc((size * 4 + 1) * size);
  const lines = [[.28,.35,.72,.35],[.58,.21,.72,.35],[.58,.49,.72,.35], [.72,.65,.28,.65],[.42,.51,.28,.65],[.42,.79,.28,.65]];
  for (let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const u=(x+.5)/size, v=(y+.5)/size;
    const offset=y*(size*4+1)+1+x*4;
    const edge=Math.hypot(Math.max(0, Math.abs(u-.5)-.28),Math.max(0,Math.abs(v-.5)-.28));
    const background = edge < .2;
    const mark=lines.some(line=>lineDistance(u,v,...line)<.035);
    if(template) {
      data[offset]=0;data[offset+1]=0;data[offset+2]=0;data[offset+3]=mark?255:0;
    } else if(background) {
      const color = mark ? [255,255,255] : [116+Math.round(29*v), 94+Math.round(15*u), 224+Math.round(12*v)];
      data.set([...color,255],offset);
    }
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(data)),chunk('IEND',Buffer.alloc(0))]);
}
mkdirSync('build',{recursive:true});mkdirSync('resources',{recursive:true});
writeFileSync('build/icon.png',png(512));
writeFileSync('resources/tray.png',png(32));
writeFileSync('resources/trayTemplate.png',png(22,true));
writeFileSync('resources/trayTemplate@2x.png',png(44,true));
const image=png(256);const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico[6]=0;ico[7]=0;ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(image.length,14);ico.writeUInt32LE(22,18);
writeFileSync('build/icon.ico',Buffer.concat([ico,image]));
