// protocol.ts - Protocol constants and buffer sizes
// Exchange: YAV (152 bytes) -> YALS (8192 bytes)

export const YAV_PACKET_SIZE = 152;
export const YALS_PACKET_SIZE = 8192;

export interface IExchangeLog {
  timestamp: number;
  direction: 'YAV_TO_YALS' | 'YALS_TO_YAV';
  size: number;
  parsed?: any; // For detailed display
}

export interface ISystemLog {
  timestamp: number;
  level: 'INFO' | 'SUCCESS' | 'ERROR' | 'SENT';
  sender?: { name: string; ip: string; port: number };
  receiver?: { name: string; ip: string; port: number };
  message: string;
  payload?: string;
  size?: number;
  module?: 'YAV' | 'YALS' | 'OPERATOR' | 'БЦВМ' | 'ЯЛС' | 'ОПЕРАТОР';
}

/**
 * Counts zero bytes in a buffer/array from start to end (exclusive)
 */
export function countZeroes(data: Uint8Array, start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end; i++) {
    if (data[i] === 0) count++;
  }
  return count;
}

/**
 * Parses 152-byte YAV packet
 */
export function parseYAV(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const angles = [];
  for (let i = 0; i < 4; i++) {
    angles.push({
      sign: view.getUint8(2 + i * 2),
      value: view.getUint8(3 + i * 2)
    });
  }
  const zeroes = countZeroes(data, 11, 152);
  return {
    index: view.getUint8(0),
    command: view.getUint8(1),
    angles,
    pyroMask: view.getUint8(10),
    zeroesInReserve: zeroes
  };
}

/**
 * Parses 8192-byte YALS packet
 */
export function parseYALS(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const angles = [];
  for (let i = 0; i < 48; i++) {
    angles.push({
      sign: view.getUint8(2 + i * 2),
      value: view.getUint8(3 + i * 2)
    });
  }
  
  const yaz = [];
  for (let i = 0; i < 192; i++) {
    yaz.push(view.getUint8(98 + i));
  }
  
  const yvp = [];
  for (let i = 0; i < 648; i++) {
    yvp.push(view.getUint8(290 + i));
  }
  
  const pyro = [];
  for (let i = 0; i < 12; i++) {
    pyro.push(view.getUint8(938 + i));
  }

  const ya_lk = [];
  for (let i = 0; i < 192; i++) {
    ya_lk.push(view.getUint8(950 + i));
  }

  const zeroes = countZeroes(data, 1142, 8192);
  
  return {
    index: view.getUint8(0),
    result: view.getUint8(1),
    angles,
    yaz,
    yvp,
    pyro,
    ya_lk,
    zeroesInReserve: zeroes
  };
}

function toBits(n: number): string {
  return n.toString(2).padStart(8, '0');
}

/**
 * Format helper for multi-line arrays with compression
 */
function formatArrayCustom(arr: number[], perLine: number, indent: string, startOffset?: number, endOffset?: number): string {
  let lines = [];
  const rangeInfo = (startOffset !== undefined && endOffset !== undefined) 
    ? ` (с ${startOffset} по ${endOffset}, всего ${arr.length} байт)` 
    : ` (всего ${arr.length} байт)`;
  
  for (let i = 0; i < arr.length; i += perLine) {
    const chunk = arr.slice(i, Math.min(i + perLine, arr.length));
    const count = chunk.length;
    
    // Check if all values in chunk are equal
    const allEqual = chunk.length > 20 && chunk.every(v => v === chunk[0]);
    
    let content = '';
    if (allEqual) {
      const start = chunk.slice(0, 16).join(',');
      const end = chunk.slice(-3).join(',');
      content = `${start},...,${end}${i + perLine < arr.length ? ',' : ''}`;
    } else {
      content = chunk.join(',') + (i + perLine < arr.length ? ',' : '');
    }
    lines.push(`${content} (${count} байт)`);
  }
  return `[${rangeInfo}\n${indent}${lines.join('\n' + indent)}\n]`;
}

function formatAnglesDetailed(angles: any[], perLine: number, indent: string, startOffset: number, endOffset: number): string {
  let lines = [];
  const totalBytes = angles.length * 2;
  const rangeInfo = ` (с ${startOffset} по ${endOffset}, всего ${totalBytes} байт)`;
  
  for (let i = 0; i < angles.length; i += perLine) {
    const chunk = angles.slice(i, Math.min(i + perLine, angles.length));
    const formatted = chunk.map(a => {
      const signBits = toBits(a.sign);
      const valBits = toBits(a.value);
      const dec = a.sign === 1 ? -a.value : a.value;
      return `[${signBits}] [${valBits}] (${dec})`;
    });
    lines.push(formatted.join(', ') + (i + perLine < angles.length ? ',' : ''));
  }
  return `[${rangeInfo}\n${indent}${lines.join('\n' + indent)}\n]`;
}

/**
 * Formats parsed data for logging
 */
export function formatParsed(parsed: any, type: 'YAV' | 'YALS'): string {
  if (type === 'YAV') {
    const angleList = parsed.angles.map((a: any) => (a.sign === 1 ? -a.value : a.value)).join(',');
    const signList = parsed.angles.map((a: any) => a.sign).join(',');
    const pyroArray = [];
    for (let i = 0; i < 8; i++) {
      pyroArray.push((parsed.pyroMask >> i) & 1);
    }
    return `[БЦВМ 152]\nИндекс: ${parsed.index}\nКоманда: ${parsed.command}\nУглы=[${angleList}]\nЗнаки: [${signList}]\nПиросредства: [${pyroArray.join(',')}] (8 бит)\nРезерв: ${parsed.zeroesInReserve}`;
  } else {
    // Detailed YALS (ЯЛС) formatting with byte offsets
    const angleStr = formatAnglesDetailed(parsed.angles, 2, '  ', 2, 97);
    const yazStr = formatArrayCustom(parsed.yaz, 48, '  ', 98, 289);
    const ylkStr = formatArrayCustom(parsed.ya_lk, 48, '  ', 950, 1141);
    const yvpStr = formatArrayCustom(parsed.yvp, 162, '  ', 290, 937);
    const pyroStr = formatArrayCustom(parsed.pyro, 12, '  ', 938, 949);
    
    return `[ЯЛС 8192]\nИндекс: ${parsed.index}\nРез: ${parsed.result}\nУглы: ${angleStr}\nЯАЗ: ${yazStr}\nПиросредства: ${pyroStr}\nЯЛК: ${ylkStr}\nЯВП: ${yvpStr}\nРезерв: ${parsed.zeroesInReserve}`;
  }
}

/**
 * Validates parsed data with detailed individual field reports
 */
export function validateParsed(parsed: any, type: 'YAV' | 'YALS') {
  const reports: string[] = [];
  let allOk = true;
  
  // Check angles
  parsed.angles.forEach((a: any, i: number) => {
    const name = `M${i+1}`;
    let motorOk = true;
    
    if (a.sign !== 0 && a.sign !== 1) {
      reports.push(`${name} знак некорректен: ${a.sign}`);
      motorOk = false;
      allOk = false;
    }
    if (a.value > 140) {
      reports.push(`${name} значение > 140: ${a.value}`);
      motorOk = false;
      allOk = false;
    }
    
    if (motorOk) {
      reports.push(`${name} знак ОК: ${a.sign}`);
    }
  });

  // Check pyro
  if (type === 'YALS') {
    parsed.pyro.forEach((p: any, i: number) => {
      const name = `Пиро[${i}]`;
      if (p !== 0 && p !== 1) {
        reports.push(`${name} некорректен: ${p}`);
        allOk = false;
      } else {
        reports.push(`${name} ОК: ${p}`);
      }
    });
  }

  return {
    ok: allOk,
    error: reports.join('\n')
  };
}
