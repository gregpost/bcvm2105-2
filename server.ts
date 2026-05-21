// server.ts - Main orchestrator
import express from 'express';
import path from 'path';
import * as fs from 'fs';
import { createServer as createViteServer } from 'vite';
import * as dgram from 'dgram';
import * as os from 'os';
import { spawn, ChildProcess, execSync } from 'child_process';
import { Client as SSHClient } from 'ssh2';
import { SERVER_CONFIG } from './src/config_data';
import { ISystemLog } from './src/protocol';

import { performance } from 'perf_hooks';

async function bootstrap() {
  console.log("Starting bootstrap...");
  
  const baseTime = Date.now();
  const basePerf = performance.now();

  const getHighResTimestamp = () => {
    return baseTime + (performance.now() - basePerf);
  };
  const LOG_DIR = '/tmp/logs';
  const LOG_FILE = path.join(LOG_DIR, 'last_run.log');
  
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  // Clear or initialize log file on start
  fs.writeFileSync(LOG_FILE, `--- SESSION START: ${new Date().toISOString()} ---\n`);

  const app = express();
  const logsTs: ISystemLog[] = [];
  const logsHw: ISystemLog[] = [];
  const nativeLogs: string[] = [];
  let yavProcess: ChildProcess | null = null;
  let yalsProcess: ChildProcess | null = null;
  let isSystemRunning = false;
  let simMode: 'cpp' | 'hw' = 'cpp'; 
  let configState = {
    yavIp: SERVER_CONFIG.ip,
    yalsIp: '127.0.0.1',   // default for sim
    yavTargetPort: 300,    // Port where YAV listens for Operator (udpPort in UI)
    operatorLocalPort: 400, // Port where Operator listens for YAV (clientLocalPort in UI)
    operatorIp: '',         // Manual override for operator IP
    asnIp: '127.0.0.1',
    asnPort: 102,
    yavAsnPort: 103,
    asnPeriod: 2000
  };
  let asnProcess: ChildProcess | null = null;

  const formatPayload = (raw: Buffer) => {
    const hexArray = Array.from(raw).map(b => b.toString(16).padStart(2, '0').toUpperCase());
    const processed: string[] = [];
    let i = 0;
    while (i < hexArray.length) {
      if (hexArray[i] === '00') {
        let start = i;
        while (i < hexArray.length && hexArray[i] === '00') i++;
        const count = i - start;
        if (count > 6) {
          processed.push("00 00 00 ... 00 00 00");
        } else {
          for (let k = 0; k < count; k++) processed.push('00');
        }
      } else {
        processed.push(hexArray[i]);
        i++;
      }
    }
    return processed.join(' ');
  };

  let operatorSocket: dgram.Socket | null = null;
  let operatorSocketBound = false;
  let lastTimeout: NodeJS.Timeout | null = null;

  const initOperatorSocket = async () => {
    if (operatorSocket) {
      try { 
        operatorSocket.removeAllListeners();
        operatorSocket.close(); 
      } catch(e) {}
    }
    
    operatorSocketBound = false;
    const socket = dgram.createSocket('udp4');
    operatorSocket = socket;
    
    // Always bind to the specified logical port as requested by user
    const BIND_PORT = configState.operatorLocalPort; 

    socket.on('message', (msg, rinfo) => {
      const respHex = '0x' + msg[0].toString(16).padStart(2, '0').toUpperCase();
      let packetName = respHex;
      let isAccepted = false;

      if (msg.length === 1) {
        const statusNames: Record<number, string> = {
          0x01: 'ПОДТВЕРЖДЕНИЕ (ACK)',
          0x02: 'ПОДТВЕРЖДЕНИЕ НАЧАЛА ДВИЖЕНИЯ',
          0x03: 'ПОДТВЕРЖДЕНИЕ ОСТАНОВКИ ДВИЖЕНИЯ',
          0x04: 'УСПЕШНЫЙ ТЕСТ',
          0x05: 'ПОДТВЕРЖДЕНИЕ ЗАГРУЗКИ ФАЙЛОВ',
          0x06: 'ПОДТВЕРЖДЕНИЕ УСТАНОВКИ ПАРАМЕТРОВ',
          0x07: 'ПОДТВЕРЖДЕНИЕ УСТАНОВКИ КОНФИГУРАЦИИ',
          100: 'ЗАГРУЗКА ЗАВЕРШЕНА'
        };
        packetName = statusNames[msg[0]] || `СТАТУС ${respHex}`;
        isAccepted = true;
      } else if (msg.length === 152) {
        packetName = 'ЗАПРОС БЦВМ';
        isAccepted = true;
      } else if (msg.length === 8192) {
        packetName = 'ОТВЕТ ЯЛС';
        isAccepted = true;
      } else if (msg.length === 8) {
        isAccepted = true;
        if (msg[0] === 0xAA) {
          if (msg[1] === 0x01) {
            const period = (msg[2] << 8) | msg[3];
            packetName = `БЦВМ -> АСН: НАСТРОЙКА (${period} мс)`;
          } else if (msg[1] === 0x02) {
            packetName = 'БЦВМ -> АСН: ОСТАНОВКА';
          } else {
            packetName = `БЦВМ -> АСН: КОМАНДА 0x${msg[1].toString(16).toUpperCase()}`;
          }
        } else if (msg[0] === 0xBB) {
          if (msg[1] === 0x00) {
            const ts = (msg[2] << 8) | msg[3];
            packetName = `АСН -> БЦВМ: ТАКТ ${ts}`;
          } else if (msg[1] === 0x03) {
            packetName = 'АСН -> БЦВМ: ПОДТВЕРЖДЕНИЕ ОСТАНОВКИ';
          } else {
            packetName = `АСН -> БЦВМ: ПАКЕТ 0x${msg[1].toString(16).toUpperCase()}`;
          }
        } else if (msg[0] === 0x04) {
          packetName = 'УСПЕШНЫЙ ТЕСТ';
        } else {
          packetName = `ПАКЕТ АСН/БЦВМ (${respHex})`;
        }
      }

      // Log any 1-byte or 8-byte (0x04 TEST) responses from BCVM to Operator
      if (msg.length === 1 || (msg.length === 8 && msg[0] === 0x04)) {
        if (msg[0] !== 0x03) {
          addLog({
            timestamp: getHighResTimestamp(),
            level: isAccepted ? 'SUCCESS' : 'INFO',
            sender: { name: 'БЦВМ', ip: rinfo.address, port: rinfo.port },
            receiver: { name: 'ОПЕРАТОР', ip: simMode !== 'hw' ? '127.0.0.1' : getLocalIp(), port: socket.address().port },
            message: `ОПЕРАТОР: Получен пакет [${packetName}]`,
            size: msg.length,
            payload: formatPayload(msg)
          });
        }
      }

      if (lastTimeout) {
        clearTimeout(lastTimeout);
        lastTimeout = null;
      }
    });

    socket.on('error', (err) => {
      console.error("Operator socket error:", err);
    });

    return new Promise<void>((resolve, reject) => {
      socket.on('error', (err) => {
        operatorSocketBound = false;
        reject(err);
      });
      socket.bind(BIND_PORT, '0.0.0.0', () => {
        const addr = socket.address();
        console.log(`Operator socket bound to port ${addr.port}`);
        operatorSocketBound = true;
        resolve();
      });
    });
  };

  const addLog = (log: ISystemLog, targetMode?: boolean) => {
    // Determine if we should use TS or HW logs based on the current mode or override
    let useLogTs = false;
    if (targetMode !== undefined) {
        useLogTs = targetMode;
    } else {
        useLogTs = (simMode === 'cpp');
    }
    const targetArr = useLogTs ? logsTs : logsHw;
    
    targetArr.push(log);
    if (targetArr.length > 200) targetArr.shift();

    const d = new Date(log.timestamp);
    const fms = ((log.timestamp % 1000) / 1000).toFixed(4).slice(2);
    const higherResIso = d.toISOString().replace(/\.\d{3}Z$/, `.${fms}Z`);

    const senderStr = log.sender ? `${log.sender.name} (${log.sender.ip}:${log.sender.port})` : 'SYSTEM';
    const receiverStr = log.receiver ? `${log.receiver.name} (${log.receiver.ip}:${log.receiver.port})` : 'SYSTEM';
    const payloadStr = log.payload ? ` [HEX: ${log.payload}]` : '';
    const sizeStr = log.size !== undefined ? ` [SIZE: ${log.size}]` : '';
    const logLine = `[${useLogTs ? 'TS' : 'HW'}] [${higherResIso}] [${log.level}] [${senderStr} -> ${receiverStr}]${sizeStr}${payloadStr} ${log.message}\n`;

    try {
      fs.appendFileSync(LOG_FILE, logLine);
    } catch (e) {
      console.error("Failed to write log to file:", e);
    }
  };

  // Telemetry listener (receiving JSON logs from C++ YAV)
  const telemetrySocket = dgram.createSocket('udp4');
  telemetrySocket.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      addLog({
        timestamp: getHighResTimestamp(),
        level: data.level || 'INFO',
        sender: data.sender,
        receiver: data.receiver,
        message: data.message || '',
        size: data.size,
        payload: data.payload
      }, simMode !== 'hw');
    } catch (e) {
      // If it's not JSON, just log as string
      addLog({
        timestamp: getHighResTimestamp(),
        level: 'INFO',
        sender: { name: 'SIM-БЦВМ', ip: '127.0.0.1', port: 0 },
        message: msg.toString()
      }, simMode !== 'hw');
    }
  });
  telemetrySocket.bind(5006, '0.0.0.0');

  const getLocalIp = () => {
    if (configState.operatorIp) return configState.operatorIp;

    const nets = os.networkInterfaces();
    // Prefer external Ethernet or Wi-Fi IPs if available
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]!) {
        // Skip internal (loopback) and non-IPv4
        if (net.family === 'IPv4' && !net.internal) {
          // If we find an IP that looks like a real network IP, return it
          // In many local setups it will be 192.168.x.x or 10.x.x.x
          return net.address;
        }
      }
    }
    // If we only have localhost, return it
    return "127.0.0.1";
  };

  const sendCommand = async (cmd: number, data?: Buffer) => {
    if (!operatorSocket || !operatorSocketBound) {
      await initOperatorSocket();
    }
    if (!operatorSocket || !operatorSocketBound) {
      console.error("Cannot send command: Operator socket not ready");
      return;
    }

    let payload: Buffer;
    if (cmd === 0x01 || cmd === 0x02 || cmd === 0x03) {
      // 0x03 (TEST) extracts the frequency from the operator input (configState.asnPeriod)
      // 0x02 (STOP) and 0x01 (START) set the frequency to 0 inside the packet.
      const period = (cmd === 0x03) ? (configState.asnPeriod || 2000) : 0;
      const periodH = (period >> 8) & 0xFF;
      const periodL = period & 0xFF;
      const header = Buffer.from([0xAA, cmd, periodH, periodL, 0, 0, 0]);
      
      let crc = 0;
      for (let i = 0; i < 7; i++) {
        crc ^= header[i];
      }
      payload = Buffer.concat([header, Buffer.from([crc])]);
    } else {
      payload = Buffer.from([cmd]);
      if (data) payload = Buffer.concat([payload, data]);
    }
    
    const localPort = operatorSocket.address().port;
    const targetIp = configState.yavIp;
    const targetPort = configState.yavTargetPort;
    
    // CRITICAL: In HW mode, we MUST use the target IP and Real Local IP.
    // In TS/CPP mode, everything is on 127.0.0.1.
    const destinationIp = simMode !== 'hw' ? '127.0.0.1' : targetIp;
    const localIp = simMode !== 'hw' ? '127.0.0.1' : getLocalIp();

    const cmdNames: Record<number, string> = {
      0x01: 'НАЧАТЬ ДВИЖЕНИЕ',
      0x02: 'ОСТАНОВИТЬ ДВИЖЕНИЕ',
      0x03: 'ТЕСТ СВЯЗИ',
      0x04: 'ОТПРАВИТЬ ФАЙЛЫ',
      0x05: 'УСТАНОВИТЬ ПАРАМЕТРЫ',
      0x06: 'УСТАНОВИТЬ КОНФИГУРАЦИЮ'
    };

    const hexBytes = Array.from(payload).map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase());
    const cmdName = cmdNames[cmd] || `0x${cmd.toString(16)}`;
    
    if (cmd === 0x01 || cmd === 0x02 || cmd === 0x03) {
      addLog({
        timestamp: getHighResTimestamp(),
        level: 'INFO',
        sender: { name: 'ОПЕРАТОР', ip: localIp, port: localPort },
        receiver: { name: 'БЦВМ', ip: destinationIp, port: targetPort },
        message: (() => {
          if (cmd === 0x03) {
            const period = configState.asnPeriod || 2000;
            const freqHz = (1000 / period).toFixed(1).replace(/\.0$/, '');
            return `ОПЕРАТОР: Отправлена команда [${cmdName}] (заданный период: ${period} мс, частота: ${freqHz} Гц)`;
          } else {
            return `ОПЕРАТОР: Отправлена команда [${cmdName}]`;
          }
        })(),
        size: payload.length,
        payload: formatPayload(payload)
      });

      if (lastTimeout) clearTimeout(lastTimeout);
      const timeoutDuration = 3000;
      const lastLogTimeout = setTimeout(() => {
          addLog({
            timestamp: getHighResTimestamp(),
            level: 'ERROR',
            message: `ОПЕРАТОР: Ошибка: Нет ответа от БЦВМ (Таймаут ${timeoutDuration/1000}с)`
          });
        lastTimeout = null;
      }, timeoutDuration);
      lastTimeout = lastLogTimeout;
    }

    operatorSocket.send(payload, targetPort, destinationIp, (err) => {
      if (err) {
        console.error("Failed to send command to YAV:", err);
        if (lastTimeout) {
          clearTimeout(lastTimeout);
          lastTimeout = null;
        }
      } else {
        console.log(`Successfully sent command ${cmd} to YAV at ${destinationIp}:${targetPort} from port ${localPort}`);
      }
    });
  };

  const startProcesses = () => {
    if (yavProcess) {
      yavProcess.kill();
      yavProcess = null;
    }
    if (yalsProcess) {
       yalsProcess.kill();
       yalsProcess = null;
    }
    if (asnProcess) {
      asnProcess.kill();
      asnProcess = null;
    }

    if (simMode === 'hw') {
      console.log("Real Hardware mode selected. No processes to start.");
      return;
    }

    if (simMode === 'cpp') {
      console.log("Rebuilding C++ system before start...");
      try {
        execSync('npx tsx run_build_scripts.ts', { stdio: 'inherit' });
      } catch (e) {
        console.error("Rebuild failed, attempting to run existing binaries...");
      }
    }

    try {
      const binPath = path.join(process.cwd(), 'cpp_system/yals/yals_simulator');
      console.log(`Starting YALS Simulator (C++) at: ${binPath}`);
      
      if (fs.existsSync(binPath)) {
          console.log(`Executing C++ binary: ${binPath}`);
          yalsProcess = spawn(binPath, ['101']);
      }

      const asnBinPath = path.join(process.cwd(), 'cpp_system/asn/asn_simulator');
      console.log(`Starting ASN Simulator (C++) at: ${asnBinPath}`);
      if (fs.existsSync(asnBinPath)) {
          console.log(`Executing C++ binary: ${asnBinPath}`);
          asnProcess = spawn(asnBinPath, [
            '--asn_port', String(configState.asnPort),
            '--yav_ip', '127.0.0.1',
            '--yav_asn_port', String(configState.yavAsnPort),
            '--telemetry_port', '5006'
          ]);
      }

      const setupProcessLogging = (proc: ChildProcess, name: string) => {
        if (!proc) return;
        proc.stdout?.on('data', (data) => {
          const lines = data.toString().split('\n');
          lines.forEach((line: string) => {
            const trimmed = line.trim();
            if (trimmed) {
              console.log(`[${name}] ${trimmed}`);
              nativeLogs.push(`[${new Date().toLocaleTimeString()}] [${name}] ${trimmed}`);
            }
          });
          if (nativeLogs.length > 500) nativeLogs.splice(0, nativeLogs.length - 500);
        });
        proc.stderr?.on('data', (data) => {
          const lines = data.toString().split('\n');
          lines.forEach((line: string) => {
            const trimmed = line.trim();
            if (trimmed) {
              console.error(`[${name} ERR] ${trimmed}`);
              nativeLogs.push(`[${new Date().toLocaleTimeString()}] [${name} ERR] ${trimmed}`);
              addLog({
                timestamp: Date.now(),
                level: 'ERROR',
                message: `[${name}] Критическая ошибка системы: ${trimmed}`
              }, (simMode === 'cpp'));
            }
          });
          if (nativeLogs.length > 500) nativeLogs.splice(0, nativeLogs.length - 500);
        });
        proc.on('error', (err) => {
          addLog({
            timestamp: Date.now(),
            level: 'ERROR',
            message: `[${name}] Ошибка запуска: ${err.message}`
          }, (simMode === 'cpp'));
        });
      };

      if (yalsProcess) setupProcessLogging(yalsProcess, 'YALS');
      if (asnProcess) setupProcessLogging(asnProcess, 'АСН');

      const clientBinPath = path.join(process.cwd(), 'cpp_system/bcvm/yav_client');
      console.log(`Starting YAV Service (C++) at: ${clientBinPath}`);
      if (fs.existsSync(clientBinPath)) {
          const args = [
            '--yav_ip', configState.yavIp,
            '--yals_ip', configState.yalsIp,
            '--operator_ip', configState.operatorIp,
            '--yals_remote_port', '101',
            '--operator_local_port', String(configState.yavTargetPort),
            '--telemetry_port', '5006',
            '--operator_remote_port', String(configState.operatorLocalPort),
            '--asn_ip', configState.asnIp,
            '--asn_local_port', String(configState.yavAsnPort),
            '--asn_remote_port', String(configState.asnPort),
            '--asn_period', String(configState.asnPeriod)
          ];
          yavProcess = spawn(clientBinPath, args);
      }

      if (yavProcess) setupProcessLogging(yavProcess, 'БЦВМ');

    } catch (error: any) {
      console.error("Failed to start processes:", error);
      addLog({
        timestamp: Date.now(),
        module: 'БЦВМ',
        level: 'ERROR',
        message: `SYSTEM: Ошибка запуска системных процессов: ${error.message || 'Unknown error'}`
      }, true);
    }
    
    if (yavProcess) {
      yavProcess.on('exit', () => { 
        console.log("YAV process exited.");
        yavProcess = null; 
        isSystemRunning = false; 
      });
    }

    if (asnProcess) {
      asnProcess.on('exit', () => {
        console.log("ASN process exited.");
        asnProcess = null;
      });
    }
  };

  const updateAndNotifyYav = async (
    ip: string, 
    operatorLocalPort: number, 
    yavTargetPort: number, 
    operatorIp?: string,
    asnPeriod?: number,
    asnPort?: number,
    yavAsnPort?: number
  ) => {
    if (ip) configState.yavIp = ip;
    if (operatorLocalPort) configState.operatorLocalPort = operatorLocalPort;
    if (yavTargetPort) configState.yavTargetPort = yavTargetPort;
    if (operatorIp !== undefined) configState.operatorIp = operatorIp;
    if (asnPeriod !== undefined) configState.asnPeriod = asnPeriod;
    if (asnPort !== undefined) configState.asnPort = asnPort;
    if (yavAsnPort !== undefined) configState.yavAsnPort = yavAsnPort;

    // Reset operator socket to use the new logical configuration
    await initOperatorSocket();
  };

  app.get('/api/logs/file', (req, res) => {
    try {
      if (fs.existsSync(LOG_FILE)) {
        const content = fs.readFileSync(LOG_FILE, 'utf8');
        res.send(content);
      } else {
        res.status(404).send('Log file not found');
      }
    } catch (e) {
      res.status(500).send('Error reading log file');
    }
  });

  app.get('/api/native-logs', (req, res) => {
    res.json({ logs: nativeLogs });
  });

  app.use(express.json({ limit: '50mb' }));

  app.post('/api/config', (req, res) => {
    const { ip, clientLocalPort, udpPort, operatorIp, asnPeriod, asnPort, yavAsnPort, start } = req.body;
    updateAndNotifyYav(ip, clientLocalPort, udpPort, operatorIp, asnPeriod, asnPort, yavAsnPort);

    if (start !== false) {
      isSystemRunning = true;
      startProcesses();
      sendCommand(0x01); // START
    }
    res.json({ status: 'success' });
  });

  app.post('/api/stop', (req, res) => {
    isSystemRunning = false;
    sendCommand(0x02); // STOP
    res.json({ status: 'success' });
  });

  app.post('/api/test-connection', (req, res) => {
    const { ip, clientLocalPort, udpPort, operatorIp, asnPeriod, asnPort, yavAsnPort, stop } = req.body;
    if (ip && clientLocalPort && udpPort) {
      updateAndNotifyYav(ip, clientLocalPort, udpPort, operatorIp, asnPeriod, asnPort, yavAsnPort);
    }
    
    if (stop) {
      sendCommand(0x02); // STOP
    } else {
      // If not running, we must start YAV at least to answer the test
      if (!yavProcess && simMode !== 'hw') {
         console.log("Starting YAV for connection test...");
         startProcesses();
         // Larger delay for cold start
         setTimeout(() => {
           sendCommand(0x03); // TEST
         }, 2000);
      } else {
        sendCommand(0x03); // TEST
      }
    }
    
    res.json({ status: 'success' });
  });

  app.post('/api/upload-files', (req, res) => {
    console.log("Uploading files to БЦВМ...");
    const dummyData = Buffer.alloc(1024, 0xAA);
    sendCommand(0x04, dummyData);
    res.json({ status: 'success' });
  });

  app.post('/api/payload', (req, res) => {
    const { angles, pyro, command } = req.body;
    const data = Buffer.alloc(10);
    if (Array.isArray(angles)) {
      for(let i=0; i<4; i++) {
        const val = angles[i] || 0;
        data[i*2] = val < 0 ? 1 : 0;
        data[1 + i*2] = Math.min(140, Math.abs(val));
      }
    }
    data[8] = pyro || 0;
    data[9] = command || 1;
    sendCommand(0x05, data); // SET_PAYLOAD
    res.json({ status: 'success' });
  });

  app.get('/api/status', (req, res) => {
    const isSimulated = simMode === 'cpp';
    const currentLogs = isSimulated ? logsTs : logsHw;
    res.json({ 
      total: currentLogs.length,
      last: null, 
      logs: currentLogs,
      isRunning: isSystemRunning,
      isTsMode: false,
      simMode: simMode,
      config: {
        ip: configState.yavIp,
        clientRemotePort: 101, // Default from C++ protocol
        clientLocalPort: configState.operatorLocalPort,
        udpPort: configState.yavTargetPort,
        operatorIp: configState.operatorIp,
        command: 1,
        asnIp: configState.asnIp,
        asnPort: configState.asnPort,
        yavAsnPort: configState.yavAsnPort,
        asnPeriod: configState.asnPeriod
      }
    });
  });

  app.post('/api/toggle-mode', (req, res) => {
    const { mode } = req.body;
    if (mode) {
      simMode = mode;
    }
    if (isSystemRunning) startProcesses();
    res.json({ status: 'success', simMode, isTsMode: false });
  });

  app.post('/api/clear-logs', (req, res) => {
    if (simMode === 'cpp') {
      logsTs.length = 0;
    } else {
      logsHw.length = 0;
    }
    res.json({ status: 'success' });
  });

  // Background compilation state
  let activeCompileProcess: any = null;
  let compileLog = '';
  let compileStatus: 'idle' | 'running' | 'success' | 'error' = 'idle';
  let compilePct = 0;
  let compileStage = '';

  const tmpDir = path.join(process.cwd(), 'tmp');
  const logFilePath = path.join(tmpDir, 'compile.log');

  if (fs.existsSync(logFilePath)) {
    try {
      compileLog = fs.readFileSync(logFilePath, 'utf8');
      if (compileLog.includes('Завершено успешно') || compileLog.includes('Компиляция завершена успешно!')) {
        compileStatus = 'success';
        compilePct = 100;
        compileStage = 'Успешно завершено!';
      } else if (compileLog.includes('Ошибка') || compileLog.includes('❌ Ошибки сборки!') || compileLog.includes('Failed building')) {
        compileStatus = 'error';
        compilePct = 100;
        compileStage = 'Завершено с ошибками';
      }
    } catch (e) {}
  }

  function appendCompileLog(data: string) {
    compileLog += data;
    try {
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      fs.appendFileSync(logFilePath, data, 'utf8');
    } catch (err) {
      console.error("Failed writing to log file:", err);
    }
  }

  function updateCompileProgress(text: string) {
    if (text.includes('gpp_installer') || text.includes('Проверка готовности огружения') || text.includes('Проверка готовности окружения')) {
      compileStage = 'Проверка наличия компилятора ARM...';
      compilePct = Math.max(compilePct, 10);
    }
    if (text.includes('Запускаем автоматическую установку')) {
      compileStage = 'Инициализации установки компилятора...';
      compilePct = Math.max(compilePct, 15);
    }
    if (text.includes('Скачивание архива') || text.includes('Attempting download') || text.includes('Скачивание GCC ARM Toolchain')) {
      compileStage = 'Скачивание Arm GNU Toolchain 15.2.rel1 (~200-300MB)...';
      compilePct = Math.max(compilePct, 25);
    }
    if (text.includes('Архив успешно скачан') || text.includes('Successfully downloaded')) {
      compileStage = 'Архив скачан. Распаковка архива (может занять 1-2 минуты)...';
      compilePct = Math.max(compilePct, 45);
    }
    if (text.includes('Распаковка завершена') || text.includes('ARM кросс-компилятор успешно настроен')) {
      compileStage = 'Настройка Toolchain завершена.';
      compilePct = Math.max(compilePct, 55);
    }
    if (text.includes('Running build.sh in cpp_system/bcvm')) {
      compileStage = 'Компиляция модуля БЦВМ (bcvm)...';
      compilePct = Math.max(compilePct, 60);
    }
    if (text.includes('Running build.sh in cpp_system/asn')) {
      compileStage = 'Компиляция модуля ASN (asn_simulator)...';
      compilePct = Math.max(compilePct, 80);
    }
    if (text.includes('Все модули успешно скомпилированы')) {
      compileStage = 'Успешно завершено!';
      compilePct = 100;
    }
    if (text.includes('❌ Ошибки сборки!') || text.includes('Error: Failed building') || text.includes('❌ Error:')) {
      compileStage = 'Сбой компиляции!';
      compilePct = 100;
    }
  }

  app.post('/api/ssh-compile', (req, res) => {
    if (compileStatus === 'running') {
      return res.json({ status: 'success', message: 'Compilation is already running' });
    }

    compileLog = '>>> Запуск кросс-компиляции для ARM в фоновом режиме...\n';
    compileStatus = 'running';
    compilePct = 5;
    compileStage = 'Запуск скрипта сборки...';

    if (!fs.existsSync(tmpDir)) {
      try {
        fs.mkdirSync(tmpDir, { recursive: true });
      } catch (err) {}
    }
    try {
      fs.writeFileSync(logFilePath, compileLog, 'utf8');
    } catch (err) {}

    const isWin = process.platform === 'win32';
    const command = isWin ? 'npx.cmd' : 'npx';
    const args = ['tsx', 'run_build_scripts.ts', '--arm', '--no-yals'];

    console.log(`Spawning background process: ${command} ${args.join(' ')}`);
    const p = spawn(command, args, {
      shell: isWin,
      env: { ...process.env }
    });

    activeCompileProcess = p;

    p.stdout.on('data', (data) => {
      const chunk = data.toString();
      appendCompileLog(chunk);
      updateCompileProgress(chunk);
    });

    p.stderr.on('data', (data) => {
      const chunk = data.toString();
      appendCompileLog(chunk);
      updateCompileProgress(chunk);
    });

    p.on('close', (code) => {
      activeCompileProcess = null;
      if (code === 0 && !compileLog.includes('❌ Ошибки сборки!') && !compileLog.includes('Error: Failed building')) {
        compileStatus = 'success';
        compilePct = 100;
        compileStage = 'Успешно завершено!';
        appendCompileLog('\n>>> Компиляция завершена успешно!\n');
      } else {
        compileStatus = 'error';
        compilePct = 100;
        compileStage = 'Завершено с ошибками';
        appendCompileLog(`\n>>> Ошибка: Процесс завершился с кодом ${code}.\n`);
      }
    });

    p.on('error', (err) => {
      activeCompileProcess = null;
      compileStatus = 'error';
      compilePct = 100;
      compileStage = 'Не удалось запустить компиляцию';
      appendCompileLog(`\n>>> Не удалось запустить процесс сборки: ${err.message}\n`);
    });

    res.json({ status: 'success', message: 'Compilation started in background' });
  });

  app.get('/api/ssh-compile-status', (req, res) => {
    res.json({
      status: compileStatus,
      pct: compilePct,
      stage: compileStage,
      output: compileLog
    });
  });

  app.post('/api/ssh-deploy', async (req, res) => {
    const { host, username, password, targetPath } = req.body;
    let outputLog = '';

    const addLog = (msg: string) => {
      console.log(msg);
      outputLog += msg + '\n';
    };

    try {
      addLog('>>> Подготовка к отправке готового бинарника по SSH...');

      // 1. Locate compiled binary - programmatically identify and select the best executable
      const binaryPaths = [
        path.join(process.cwd(), 'cpp_system', 'bcvm', 'yav_client_arm'),
        path.join(process.cwd(), 'cpp_system', 'bcvm', 'yav_client'),
        path.join(process.cwd(), 'build', 'bcvm', 'yav_client_arm'),
        path.join(process.cwd(), 'build', 'bcvm', 'yav_client'),
        path.join(process.cwd(), 'yav_client_arm'),
        path.join(process.cwd(), 'yav_client'),
      ];

      const candidates = binaryPaths.filter(p => fs.existsSync(p));
      const evaluatedCandidates = candidates.map(p => {
        try {
          const fd = fs.openSync(p, 'r');
          const buffer = Buffer.alloc(4);
          fs.readSync(fd, buffer, 0, 4, 0);
          fs.closeSync(fd);
          const isElf = buffer[0] === 0x7F && buffer[1] === 0x45 && buffer[2] === 0x4C && buffer[3] === 0x46; // \x7fELF
          const isExe = buffer[0] === 0x4D && buffer[1] === 0x5A; // MZ header
          const mtime = fs.statSync(p).mtimeMs;
          const name = path.basename(p);
          const isArmNamed = name.includes('arm');
          return { path: p, isElf, isExe, mtime, isArmNamed };
        } catch (e) {
          return { path: p, isElf: false, isExe: false, mtime: 0, isArmNamed: false };
        }
      });

      // Sort evaluated candidates:
      // 1. Highly prefer Linux ELF binaries over Windows MSVC EXEs
      // 2. Prefer ARM-named files (e.g., yav_client_arm)
      // 3. Prefer the newest modified file
      evaluatedCandidates.sort((a, b) => {
        if (a.isElf && !b.isElf) return -1;
        if (!a.isElf && b.isElf) return 1;
        if (a.isArmNamed && !b.isArmNamed) return -1;
        if (!a.isArmNamed && b.isArmNamed) return 1;
        return b.mtime - a.mtime;
      });

      let selectedBinary = '';
      if (evaluatedCandidates.length > 0) {
        selectedBinary = evaluatedCandidates[0].path;
        const info = evaluatedCandidates[0];
        addLog(`>>> Выбран файл для отправки: ${selectedBinary}`);
        addLog(`    Тип формата: ${info.isElf ? 'Linux ELF (Рекомендуется)' : info.isExe ? 'Windows PE/EXE (Несовместим с Linux)' : 'Неопределено'}`);
        addLog(`    Время сборки: ${new Date(info.mtime).toLocaleString()}`);
        
        if (info.isExe) {
          addLog('⚠️ ВНИМАНИЕ: Выбран исполняемый файл Windows (.exe). Он не запустится на удаленном Линуксе!');
          addLog('   Пожалуйста, собирайте бинарник непосредственно в облачном контейнере или под WSL с компилятором arm-linux-gnueabihf.');
        }
      }

      if (!selectedBinary) {
        throw new Error('Исполняемый файл yav_client не найден! Обязательно выполните компиляцию перед отправкой.');
      }

      // 2. Optional network interface configuration if running on Linux host
      if (process.platform === 'linux') {
        const hasEnp0s8 = fs.existsSync('/sys/class/net/enp0s8');
        if (hasEnp0s8) {
          try {
            addLog('>>> Настройка локального сетевого интерфейса (enp0s8)...');
            execSync('sudo ip addr flush dev enp0s8', { stdio: 'ignore' });
            execSync('sudo ip addr add 192.168.17.233/24 dev enp0s8', { stdio: 'ignore' });
            addLog('Сетевой интерфейс enp0s8 успешно настроен.');
          } catch (netErr: any) {
            addLog('Примечание: Не удалось настроить локальный IP на интерфейсе enp0s8. Возможно, отсутствуют права sudo. Используются стандартные сетевые параметры.');
          }
        } else {
          addLog('>>> Примечание: Сетевой интерфейс enp0s8 отсутствует на данном хосте. Дополнительная настройка локального IP не требуется.');
        }
      }

      // 3. Secure programmatic upload using SSH2
      const sshHost = host || '192.168.17.246';
      const sshUser = username || 'root';
      const sshPass = password || '';
      let remoteFile = targetPath || '/home/yav_client';

      // If user provided a directory (e.g. /home or /home/), append yav_client
      if (remoteFile === '/home' || remoteFile === '/home/') {
        remoteFile = '/home/yav_client';
      } else if (remoteFile.endsWith('/')) {
        remoteFile = remoteFile + 'yav_client';
      }

      addLog(`>>> Установка SSH-соединения с ${sshUser}@${sshHost}:22 ...`);
      
      const sshResult = await new Promise<string>((resolve, reject) => {
        const conn = new SSHClient();
        let sshLogs = '';
        
        conn.on('ready', () => {
          sshLogs += 'SSH-соединение успешно установлено.\n';
          conn.sftp((sftpErr, sftp) => {
            if (sftpErr) {
              conn.end();
              return reject(new Error('Не удалось запустить SFTP-сессию: ' + sftpErr.message));
            }
            
            sshLogs += `SFTP-сессия запущена. Загрузка файла в remote:${remoteFile} ...\n`;
            sftp.fastPut(selectedBinary, remoteFile, (uploadErr) => {
              if (uploadErr) {
                conn.end();
                return reject(new Error('Загрузка файла по SFTP не удалась: ' + uploadErr.message));
              }
              
              sshLogs += `Файл успешно загружен в ${remoteFile}. Установка прав на исполнение (chmod +x)...\n`;
              conn.exec(`chmod +x "${remoteFile}"`, (execErr, stream) => {
                if (execErr) {
                  sshLogs += `Предупреждение: Не удалось выполнить chmod на удаленном хосте: ${execErr.message}\n`;
                  conn.end();
                  return resolve(sshLogs);
                }
                
                stream.on('close', (code: number) => {
                  sshLogs += `Права изменены успешно. (Код выхода chmod: ${code})\n`;
                  conn.end();
                  resolve(sshLogs);
                }).on('data', (d: any) => {
                  sshLogs += `Удаленный вывод: ${d.toString()}\n`;
                }).stderr.on('data', (d: any) => {
                  sshLogs += `Удаленная ошибка: ${d.toString()}\n`;
                });
              });
            });
          });
        }).on('error', (err) => {
          reject(new Error('Ошибка SSH-соединения: ' + err.message));
        }).connect({
          host: sshHost,
          port: 22,
          username: sshUser,
          password: sshPass,
          readyTimeout: 15000
        });
      });

      addLog(sshResult);
      addLog('>>> ДЕПЛОЙ ПО SSH ЗАВЕРШЕН УСПЕШНО!');
      res.json({ status: 'success', output: outputLog });

    } catch (error: any) {
      addLog(`>>> ОШИБКА ДЕПЛОЯ: ${error.message}`);
      res.status(500).json({ 
        status: 'error', 
        error: error.message, 
        output: outputLog 
      });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const PORT = 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

bootstrap();
