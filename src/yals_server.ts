// yals_server.ts - YALS (Slave) UDP server implementation
import * as dgram from 'dgram';
import { YAV_PACKET_SIZE, YALS_PACKET_SIZE, ISystemLog, parseYAV, parseYALS, formatParsed, validateParsed } from './protocol';

export class YalsServer {
  private server: dgram.Socket;
  private staticMemory: Uint8Array = new Uint8Array(YALS_PACKET_SIZE);

  constructor(public port: number, public host: string, private onLog?: (log: ISystemLog) => void) {
    const view = new DataView(this.staticMemory.buffer);
    view.setUint8(0, 1); 
    view.setUint8(1, 2); 
    
    this.server = dgram.createSocket('udp4');

    this.server.on('message', (msg, rinfo) => {
      if (msg.length === YAV_PACKET_SIZE) {
        const parsedReceived = parseYAV(new Uint8Array(msg));
        this.log('INFO', `Received:\n${formatParsed(parsedReceived, 'YAV')} from ${rinfo.address}:${rinfo.port}`);
        
        const command = parsedReceived.command;
        if (command === 1 || command === 8) {
          const v = new DataView(this.staticMemory.buffer);
          v.setUint8(1, command === 1 ? 2 : 3);
          const parsedSent = parseYALS(this.staticMemory);
          this.log('INFO', `Sending:\n${formatParsed(parsedSent, 'YALS')}`);
          this.server.send(Buffer.from(this.staticMemory), rinfo.port, rinfo.address);
        }
      }
    });

    this.server.on('error', (err) => {
      this.log('ERROR', `Server socket error: ${err.message}`);
    });
  }

  private log(level: 'INFO' | 'SUCCESS' | 'ERROR', message: string) {
    if (this.onLog) {
      this.onLog({ timestamp: Date.now(), module: 'YALS', level, message });
    }
  }

  public start(): void {
    this.server.bind(this.port, this.host, () => {
      this.log('INFO', `YALS Server (TS) listening on ${this.host}:${this.port}`);
    });
  }

  public stop(): void {
    try { this.server.close(); } catch (e) {}
  }
}
