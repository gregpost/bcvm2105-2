// yav_client.ts - YAV (Master) UDP client implementation
import * as dgram from 'dgram';
import { YAV_PACKET_SIZE, YALS_PACKET_SIZE, IExchangeLog, ISystemLog, parseYAV, parseYALS, formatParsed, validateParsed } from './protocol';

export class YavClient {
  private staticMemory: Uint8Array = new Uint8Array(YAV_PACKET_SIZE);
  public lastLog: IExchangeLog | null = null;
  public totalExchanges: number = 0;
  public motorAngles: number[] = [0, 0, 0, 0];
  public pyroMask: number = 0;

  constructor(public port: number, public host: string, private onLog?: (log: ISystemLog) => void, private displayHost?: string, public command: number = 1, public localPort?: number) {
  }

  public setPayload(angles: number[], pyro: number) {
    this.motorAngles = angles.slice(0, 4);
    this.pyroMask = pyro;
    this.log('INFO', `Payload updated in client: Angles=[${this.motorAngles}], Pyro=${this.pyroMask}`);
  }

  private log(level: 'INFO' | 'SUCCESS' | 'ERROR', message: string) {
    console.log(`[YAV] ${message}`);
    if (this.onLog) {
      this.onLog({ timestamp: Date.now(), module: 'YAV', level, message });
    }
  }

  public async exchange(): Promise<void> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      let resolved = false;
      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeoutId);
        try { socket.close(); } catch (e) {}
      };

      const timeoutId = setTimeout(() => {
        this.log('ERROR', 'Таймаут обмена данными');
        cleanup();
        resolve();
      }, 3000);

      socket.on('error', (err: any) => {
        if (!resolved) {
          this.log('ERROR', `Ошибка сокета: ${err.message}`);
          cleanup();
          resolve(); 
        }
      });

      if (this.localPort) {
        try { socket.bind({ port: this.localPort, exclusive: false }); } catch (e: any) {}
      }

      const targetPort = this.port || 5001;
      const view = new DataView(this.staticMemory.buffer);
      view.setUint8(0, 1);
      view.setUint8(1, this.command);

      const isWriteCommand = Number(this.command) === 8;
      if (isWriteCommand) {
        for (let i = 0; i < 4; i++) {
          const val = this.motorAngles[i] || 0;
          view.setUint8(2 + i * 2, val < 0 ? 1 : 0);
          view.setUint8(3 + i * 2, Math.min(140, Math.abs(val)));
        }
        view.setUint8(10, this.pyroMask);
      }
      
      const parsedSent = parseYAV(this.staticMemory);
      this.log('INFO', `Отправка на ${this.host}:${targetPort} [${YAV_PACKET_SIZE} байт]:\n${formatParsed(parsedSent, 'YAV')}`);
      
      socket.send(Buffer.from(this.staticMemory), targetPort, this.host);

      socket.on('message', (msg) => {
        if (msg.length === YALS_PACKET_SIZE) {
          const parsedReceived = parseYALS(new Uint8Array(msg));
          const validation = validateParsed(parsedReceived, 'YALS');
          this.log(validation.ok ? 'SUCCESS' : 'ERROR', `Валидация: ${validation.ok?'ОК':'ОШИБКА'}\n${formatParsed(parsedReceived, 'YALS')}`);
          cleanup();
          resolve();
        }
      });
    });
  }
}
