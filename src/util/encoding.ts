const CP850_HIGH =
  'ÇüéâäàåçêëèïîìÄÅ' +
  'ÉæÆôöòûùÿÖÜø£Ø×ƒ' +
  'áíóúñÑªº¿®¬½¼¡«»' +
  '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
  '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' +
  'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' +
  'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' +
  '\u00ad±‗¾¶§÷¸°¨·¹³²■\u00a0';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('windows-1252');

export function decodeConsoleBytes(bytes: Uint8Array, platform: NodeJS.Platform = process.platform): string {
  if (!bytes.length) return '';
  try {
    return strictUtf8.decode(bytes);
  } catch {
    if (platform === 'win32') {
      let out = '';
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        out += b < 128 ? String.fromCharCode(b) : CP850_HIGH[b - 128];
      }
      return out;
    }
    return latin1.decode(bytes);
  }
}


function completeUtf8Length(buf: Uint8Array): number {
  let cursor = buf.length;
  while (cursor > 0 && buf.length - cursor < 4) {
    const b = buf[cursor - 1];
    if (b < 0x80) return buf.length;
    if (b >= 0xc0) {
      const needed = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : 2;
      const available = buf.length - (cursor - 1);
      return available >= needed ? buf.length : cursor - 1;
    }
    cursor--;
  }
  return buf.length;
}

export class StreamingConsoleDecoder {
  private pending: Buffer = Buffer.alloc(0);

  write(chunk: Buffer): string {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    const ready = completeUtf8Length(this.pending);
    if (!ready) return '';
    const text = decodeConsoleBytes(this.pending.subarray(0, ready));
    this.pending = Buffer.from(this.pending.subarray(ready));
    return text;
  }

  end(): string {
    if (!this.pending.length) return '';
    const text = decodeConsoleBytes(this.pending);
    this.pending = Buffer.alloc(0);
    return text;
  }
}

export function isProbablyBinary(sample: Buffer): boolean {
  const len = Math.min(sample.length, 8192);
  if (!len) return false;
  let suspicious = 0;
  for (let i = 0; i < len; i++) {
    const b = sample[i];
    if (b === 0) return true;
    if (b < 7 || (b > 14 && b < 32)) suspicious++;
  }
  return suspicious / len > 0.3;
}
