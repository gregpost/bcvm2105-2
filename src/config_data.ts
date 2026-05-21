// src/config_data.ts - Configuration structures for network setup

export const LOG_POLL_INTERVAL_MS = 500;

export class NetworkConfig {
  public ip: string = "127.0.0.1";
  public localPort: number = 0;
  public remotePort: number = 0;
  public defaultCommand: number = 1;
}

export const SERVER_CONFIG = new NetworkConfig();
SERVER_CONFIG.ip = "127.0.0.1";
SERVER_CONFIG.localPort = 300;
SERVER_CONFIG.defaultCommand = 1;

export const CLIENT_CONFIG = new NetworkConfig();
CLIENT_CONFIG.ip = "127.0.0.1";
CLIENT_CONFIG.localPort = 0;
CLIENT_CONFIG.remotePort = 101;
CLIENT_CONFIG.defaultCommand = 1;
