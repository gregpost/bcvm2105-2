// App.tsx - Frontend visualizer for the system state
// Displays real-time exchange stats from the backend

import React, { useState, useEffect, useRef } from 'react';
import { IExchangeLog, ISystemLog } from './protocol';
import { motion, AnimatePresence } from 'motion/react';
import { Play, Square, Terminal, Activity, Pause } from 'lucide-react';
import { LOG_POLL_INTERVAL_MS } from './config_data';

export default function App() {
  const STORAGE_PREFIX = `yav_${window.location.host}_`;
  const [status, setStatus] = useState<{ total: number; last: IExchangeLog | null; logs: ISystemLog[]; isRunning: boolean; isTsMode: boolean; simMode: 'cpp' | 'hw' }>({ 
    total: 0, 
    last: null,
    logs: [],
    isRunning: false,
    isTsMode: false,
    simMode: 'cpp'
  });
  const [fullConfig, setFullConfig] = useState(() => {
    const saved = localStorage.getItem(STORAGE_PREFIX + 'full_config');
    if (saved) return JSON.parse(saved);
    
    return {
      sim: {
        ip: '127.0.0.1',
        operatorIp: '',
        clientRemotePort: 101,
        clientLocalPort: 400,
        udpPort: 300,
        command: 1,
        asnPeriod: 2000,
        asnPort: 102,
        yavAsnPort: 103
      },
      hw: {
        ip: '192.168.17.246',
        operatorIp: '',
        clientRemotePort: 101,
        clientLocalPort: 400,
        udpPort: 300,
        command: 1,
        asnPeriod: 2000,
        asnPort: 102,
        yavAsnPort: 103
      }
    };
  });

  const isSimulated = status.simMode === 'cpp';
  const config = isSimulated ? fullConfig.sim : fullConfig.hw;

  const setConfig = (newVal: any) => {
    setFullConfig(prev => {
      const updated = {
        ...prev,
        [isSimulated ? 'sim' : 'hw']: newVal
      };
      localStorage.setItem(STORAGE_PREFIX + 'full_config', JSON.stringify(updated));
      return updated;
    });
  };
  const [payload, setPayload] = useState<{ angles: (number | string)[]; pyro: boolean[] }>(() => {
    const saved = localStorage.getItem(STORAGE_PREFIX + 'payload');
    return saved ? JSON.parse(saved) : {
      angles: [0, 0, 0, 0],
      pyro: [false, false, false, false, false, false, false, false]
    };
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentScrollRef = useRef<HTMLDivElement>(null);
  const recvScrollRef = useRef<HTMLDivElement>(null);

  const saveConfig = async () => {
    try {
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...config, start: true })
      });
      shouldAutoScroll.current = true;
      shouldAutoScrollSent.current = true;
      shouldAutoScrollRecv.current = true;
      setIsPaused(false);
      setPausedLogsSnapshot(null);
    } catch (e) {
      console.error('Failed to update configuration.');
    }
  };

  const [isTesting, setIsTesting] = useState(false);
  const [asnTestActive, setAsnTestActive] = useState(false);
  const testStartTime = useRef<number>(0);

  // Automatically reset active test if system is started
  useEffect(() => {
    if (status.isRunning) {
      setAsnTestActive(false);
    }
  }, [status.isRunning]);
  const [collapsed, setCollapsed] = useState({ operator: false, yav: false, yals: false });
  const [logMode, setLogMode] = useState<'single' | 'double' | 'triple'>('triple');
  const [isPaused, setIsPaused] = useState(false);
  const [pausedLogsSnapshot, setPausedLogsSnapshot] = useState<ISystemLog[] | null>(null);
  const [isPayloadUpdating, setIsPayloadUpdating] = useState(false);
  const [files, setFiles] = useState({ cyclogram: '', mission: '' });
  const hintTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [showStartHint, setShowStartHint] = useState(false);

  const [isSshCompiling, setIsSshCompiling] = useState(false);
  const [isSshDeploying, setIsSshDeploying] = useState(false);
  const [sshDeployOutput, setSshDeployOutput] = useState('');
  const [sshHost, setSshHost] = useState('192.168.17.246');
  const [sshUsername, setSshUsername] = useState('root');
  const [sshPassword, setSshPassword] = useState('');
  const [sshTargetPath, setSshTargetPath] = useState('/home/yav_client');

  const [compileProgress, setCompileProgress] = useState({ pct: 0, stage: '' });
  const [isSshDetailsOpen, setIsSshDetailsOpen] = useState(() => {
    const saved = localStorage.getItem(STORAGE_PREFIX + 'ssh_details_open');
    return saved === 'true';
  });
  const sshLogEndRef = useRef<HTMLDivElement>(null);

  // Poll compilation status on mount
  useEffect(() => {
    const checkCompileStatus = async () => {
      try {
        const resp = await fetch('/api/ssh-compile-status');
        const data = await resp.json();
        if (data.output) {
          setSshDeployOutput(data.output);
        }
        if (data.pct !== undefined && data.stage !== undefined) {
          setCompileProgress({ pct: data.pct, stage: data.stage });
        }
        if (data.status === 'running') {
          setIsSshCompiling(true);
        }
      } catch (e) {
        console.error('Failed to get compilation status on mount:', e);
      }
    };
    checkCompileStatus();
  }, [STORAGE_PREFIX]);

  // Poll compilation status when compilation is active
  useEffect(() => {
    if (!isSshCompiling) return;

    let timer: NodeJS.Timeout;
    const poll = async () => {
      try {
        const resp = await fetch('/api/ssh-compile-status');
        const data = await resp.json();
        if (data.output) {
          setSshDeployOutput(data.output);
        }
        if (data.pct !== undefined && data.stage !== undefined) {
          setCompileProgress({ pct: data.pct, stage: data.stage });
        }
        if (data.status !== 'running') {
          setIsSshCompiling(false);
        }
      } catch (e) {
        console.error('Error polling compile status:', e);
      }
    };

    timer = setInterval(poll, 1000);
    poll();

    return () => clearInterval(timer);
  }, [isSshCompiling]);

  // Scroll to bottom of ssh logs when output updates
  useEffect(() => {
    if (sshLogEndRef.current) {
      sshLogEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [sshDeployOutput, isSshCompiling]);

  const sendFiles = async () => {
    if (!files.cyclogram || !files.mission) return;
    setIsPayloadUpdating(true);
    try {
      const res = await fetch('/api/upload-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(files)
      });
      const data = await res.json();
      if (data.status === 'success') {
        setTimeout(() => setIsPayloadUpdating(false), 2000);
      } else {
        setIsPayloadUpdating(false);
      }
    } catch (e) {
      console.error('Failed to upload files.');
      setIsPayloadUpdating(false);
    }
  };

  const handleSshCompile = async () => {
    setIsSshCompiling(true);
    setSshDeployOutput('Команда компиляции запущена в фоновом режиме...\n');
    setCompileProgress({ pct: 5, stage: 'Запуск компиляции...' });
    try {
      const resp = await fetch('/api/ssh-compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await resp.json();
      if (!resp.ok || data.status !== 'success') {
        setSshDeployOutput(prev => prev + `\nНе удалось запустить сборку: ${data.error || 'Неизвестная ошибка'}`);
        setIsSshCompiling(false);
      }
    } catch (e: any) {
      setSshDeployOutput(prev => prev + `\nОшибка сети: ${e.message || e}`);
      setIsSshCompiling(false);
    }
  };

  const handleSshDeploy = async () => {
    setIsSshDeploying(true);
    setSshDeployOutput('Начало загрузки по SSH...\n');
    try {
      const resp = await fetch('/api/ssh-deploy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          host: sshHost,
          username: sshUsername,
          password: sshPassword,
          targetPath: sshTargetPath
        })
      });
      const data = await resp.json();
      if (resp.ok && data.status === 'success') {
        setSshDeployOutput(data.output || 'Успешно отправлено.');
      } else {
        setSshDeployOutput(data.output || `Ошибка: ${data.error || 'Неизвестная ошибка'}`);
      }
    } catch (e: any) {
      setSshDeployOutput(`Ошибка сети: ${e.message || e}`);
    } finally {
      setIsSshDeploying(false);
    }
  };

  const testConnection = async () => {
    setIsTesting(true);
    testStartTime.current = Date.now();
    try {
      await fetch('/api/test-connection', { 
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          ip: config.ip,
          operatorIp: config.operatorIp,
          clientLocalPort: config.clientLocalPort,
          udpPort: config.udpPort,
          asnPeriod: config.asnPeriod,
          asnPort: config.asnPort,
          yavAsnPort: config.yavAsnPort,
          stop: asnTestActive
        })
      });
      setAsnTestActive(prev => !prev);
      setTimeout(() => setIsTesting(false), 1000);
    } catch (e) {
      console.error('Failed to test connection.');
      setIsTesting(false);
    }
  };

  const shouldAutoScroll = useRef(true);
  const shouldAutoScrollSent = useRef(true);
  const shouldAutoScrollRecv = useRef(true);

  const handleScroll = (ref: React.RefObject<HTMLDivElement>, autoScrollRef: React.MutableRefObject<boolean>) => {
    if (!ref.current) return;
    const el = ref.current;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 10;
  };

  const togglePause = () => {
    if (!isPaused) {
      setPausedLogsSnapshot(status.logs);
    } else {
      setPausedLogsSnapshot(null);
    }
    setIsPaused(!isPaused);
  };

  const updatePayload = async () => {
    let mask = 0;
    payload.pyro.forEach((bit, i) => {
      if (bit) mask |= (1 << i);
    });

    setIsPayloadUpdating(true);
    try {
      await fetch('/api/payload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          angles: payload.angles.map(a => parseInt(String(a)) || 0), 
          pyro: mask,
          command: config.command
        })
      });
      setTimeout(() => setIsPayloadUpdating(false), 1500);
    } catch (e) {
      console.error('Failed to update payload.');
      setIsPayloadUpdating(false);
    }
  };

  const stopSystem = async () => {
    try {
      await fetch('/api/stop', { method: 'POST' });
      setIsPaused(true);
      setPausedLogsSnapshot(status.logs);
    } catch (e) {
      console.error('Failed to stop system.');
    }
  };

  const [fileLogs, setFileLogs] = useState<string>('');
  const [showFileLogs, setShowFileLogs] = useState(false);
  const [nativeLogs, setNativeLogs] = useState<string[]>([]);
  const [showNativeLogs, setShowNativeLogs] = useState(false);

  const fetchFileLogs = async () => {
    try {
      const resp = await fetch('/api/logs/file');
      const text = await resp.text();
      setFileLogs(text);
      setShowFileLogs(true);
      setShowNativeLogs(false);
    } catch (e) {
      console.error("Failed to fetch file logs", e);
    }
  };

  const fetchNativeLogs = async () => {
    try {
      const resp = await fetch('/api/native-logs');
      const data = await resp.json();
      setNativeLogs(data.logs || []);
      setShowNativeLogs(true);
      setShowFileLogs(false);
    } catch (e) {
      console.error("Failed to fetch native logs", e);
    }
  };

  const clearLogs = async () => {
    try {
      await fetch('/api/clear-logs', { method: 'POST' });
      setStatus(prev => ({ ...prev, logs: [] }));
    } catch (e) {
      console.error('Failed to clear logs.');
    }
  };

  const toggleDevelopmentMode = async (mode: 'cpp' | 'hw') => {
    try {
      localStorage.setItem(STORAGE_PREFIX + 'sim_mode', mode);
      setIsPaused(false);
      setPausedLogsSnapshot(null);
      
      const currentModeConfig = (mode === 'cpp') ? fullConfig.sim : fullConfig.hw;
      
      await fetch('/api/toggle-mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: mode, isTsMode: false })
      });
      
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...currentModeConfig, start: false })
      });

      setStatus(prev => ({ ...prev, simMode: mode, isTsMode: false }));
    } catch (e) {
      console.error('Failed to toggle development mode.');
    }
  };

  useEffect(() => {
    // We already save in the setConfig wrapper above
  }, [fullConfig]);

  useEffect(() => {
    localStorage.setItem(STORAGE_PREFIX + 'payload', JSON.stringify(payload));
  }, [payload]);

  useEffect(() => {
    let firstLoad = true;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        setStatus(data);
        if (firstLoad) {
          firstLoad = false;
          
          // Determine the target mode (either restored from localStorage or from server default)
          const savedMode = (localStorage.getItem(STORAGE_PREFIX + 'sim_mode') as 'cpp' | 'hw' | null) || data.simMode || 'cpp';
          
          // Load the corresponding cached config directly from localStorage to ensure latest client values are used
          const savedConfigStr = localStorage.getItem(STORAGE_PREFIX + 'full_config');
          let currentModeConfig;
          if (savedConfigStr) {
            const parsedConfig = JSON.parse(savedConfigStr);
            currentModeConfig = (savedMode === 'cpp') ? parsedConfig.sim : parsedConfig.hw;
          } else {
            currentModeConfig = (savedMode === 'cpp') ? fullConfig.sim : fullConfig.hw;
          }

          // Force-sync both mode and mode-specific config on the backend
          await fetch('/api/toggle-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: savedMode, isTsMode: false })
          });
          
          await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...currentModeConfig, start: false })
          });

          setStatus(prev => ({ ...prev, simMode: savedMode, isTsMode: false }));
        }
      } catch (e) { /* silent */ }
    };
    const interval = setInterval(fetchStatus, LOG_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isPaused && scrollRef.current && shouldAutoScroll.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [status.logs, isPaused]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!isPaused && scrollRef.current && shouldAutoScroll.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, LOG_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isPaused]);

  const sentCount = status.logs.filter(l => l.module === 'YAV').length;
  const recvCount = status.logs.filter(l => l.module === 'YALS').length;

  const renderLogEntry = (log: ISystemLog, i: number) => {
    const formatTime = (ts: number) => {
      const d = new Date(ts);
      const h = d.getHours().toString().padStart(2, '0');
      const m = d.getMinutes().toString().padStart(2, '0');
      const s = d.getSeconds().toString().padStart(2, '0');
      const fms = ((ts % 1000) / 1000).toFixed(4).slice(2);
      return `${h}:${m}:${s}.${fms}`;
    };

    const renderEntity = (ent: any) => {
      if (!ent) return <span className="text-neutral-300">-</span>;
      return (
        <div className="flex flex-col leading-tight">
          <span className="font-bold text-[10px]">{ent.name}</span>
          <span className="text-[9px] text-neutral-400 font-mono tracking-tighter">{ent.ip}:{ent.port}</span>
        </div>
      );
    };

    return (
      <motion.div 
        key={`${log.timestamp}-${i}`}
        initial={{ y: 5, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="grid grid-cols-[120px_120px_120px_60px_180px_1fr] gap-4 py-1.5 border-b border-neutral-100 items-start hover:bg-neutral-50 transition-colors"
      >
        <span className="text-neutral-400 text-[10px] font-mono tabular-nums pt-1">{formatTime(log.timestamp)}</span>
        <div className="pt-0.5">{renderEntity(log.sender)}</div>
        <div className="pt-0.5">{renderEntity(log.receiver)}</div>
        <div className="pt-0.5 font-mono text-[10px] text-neutral-500 tabular-nums">
          {log.size ?? '-'}
        </div>
        <div className="pt-0.5 font-mono text-[9px] text-neutral-400 whitespace-pre-wrap break-all leading-tight">
          {log.payload || '-'}
        </div>
        <div className={`font-mono text-[11px] whitespace-pre-wrap break-all flex-1 pt-0.5 ${
          log.level === 'SUCCESS' ? 'text-green-600' :
          log.level === 'ERROR' ? 'text-red-600' :
          'text-neutral-600'
        }`}>
          {log.message.split('\n').map((line, j) => {
            let color = '';
            const upperLine = line.toUpperCase();
            if ((upperLine.includes('OK') || upperLine.includes('УСПЕШН') || upperLine.includes('ПОЛУЧЕН ОТВЕТ') || upperLine.includes('ПОДТВЕРЖДЕНИЕ')) && !upperLine.includes('FAILED') && !upperLine.includes('ОШИБК')) color = 'text-green-600 font-bold';
            else if (upperLine.includes('INVALID') || upperLine.includes('FAILED') || upperLine.includes('ОШИБКА') || upperLine.includes('ERROR') || upperLine.includes('ТАЙМАУТ')) color = 'text-red-600 font-bold';
            return <div key={j} className={color}>{line}</div>;
          })}
        </div>
      </motion.div>
    );
  };

  return (
    <div className="flex flex-col h-screen bg-neutral-50 text-neutral-900 font-mono p-2 md:p-4 overflow-hidden">
      <div className="w-full grid grid-cols-1 lg:grid-cols-4 gap-4 h-full">
        <div className="lg:col-span-1 space-y-4 h-full overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-neutral-300">
          <div className="p-1 relative">
            <div 
              onMouseEnter={() => {
                hintTimerRef.current = setTimeout(() => setShowStartHint(true), 500);
              }}
              onMouseLeave={() => {
                if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
                setShowStartHint(false);
              }}
            >
              <motion.button 
                whileTap={{ scale: status.isRunning || (files.cyclogram && files.mission) ? 0.98 : 1 }}
                onClick={status.isRunning ? stopSystem : saveConfig}
                disabled={!status.isRunning && (!files.cyclogram || !files.mission)}
                className={`w-full py-3 text-sm font-bold rounded-lg flex items-center justify-center gap-2 transition-all shadow-xl ${
                  status.isRunning 
                  ? 'bg-red-50 border border-red-200 text-red-600 hover:bg-red-100' 
                  : (!files.cyclogram || !files.mission)
                    ? 'bg-neutral-200 text-neutral-400 cursor-not-allowed shadow-none'
                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-500/20'
                }`}
              >
                {status.isRunning ? (
                  <>
                    <Square size={14} fill="currentColor" />
                    ОСТАНОВИТЬ ДВИЖЕНИЕ
                  </>
                ) : (
                  <>
                    <Play size={14} fill="currentColor" />
                    НАЧАТЬ ДВИЖЕНИЕ
                  </>
                )}
              </motion.button>
              
              <AnimatePresence>
                {showStartHint && !status.isRunning && (!files.cyclogram || !files.mission) && (
                  <motion.div
                    initial={{ height: 0, opacity: 0, marginTop: 0 }}
                    animate={{ height: 'auto', opacity: 1, marginTop: 8 }}
                    exit={{ height: 0, opacity: 0, marginTop: 0 }}
                    transition={{ duration: 0.15, ease: "easeOut" }}
                    className="overflow-hidden"
                  >
                    <div className="p-2 bg-red-50 border border-red-100 rounded-md">
                      <p className="text-[10px] text-red-500 font-bold text-center leading-tight uppercase tracking-wider">
                        Сначала загрузите полётное задание и циклограмму
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          <div className="px-1">
            <motion.button 
              whileTap={{ scale: 0.98 }}
              onClick={testConnection}
              disabled={isTesting}
              className={`w-full py-2 text-xs font-bold rounded-lg flex items-center justify-center gap-2 transition-all border shadow-sm ${
                isTesting 
                  ? 'opacity-50 cursor-not-allowed bg-neutral-100 text-neutral-400 border-neutral-200' 
                  : asnTestActive 
                    ? 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100' 
                    : 'bg-white text-neutral-600 border-neutral-200 hover:bg-neutral-50'
              }`}
            >
              {isTesting ? (
                <>
                  <motion.div
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 1, ease: "linear" }}
                  >
                    <Activity size={12} />
                  </motion.div>
                  ОТПРАВКА ЗАПРОСА...
                </>
              ) : asnTestActive ? (
                <>
                  <Activity size={12} className="text-red-500 animate-pulse" />
                  АСН ЗАПУЩЕН / ОСТАНОВИТЬ ТЕСТ
                </>
              ) : (
                <>
                  <Activity size={12} />
                  ТЕСТ СВЯЗИ
                </>
              )}
            </motion.button>
          </div>

          <details className={`bg-white border border-neutral-200 rounded-lg shadow-xl group border-l-4 ${isSimulated ? 'border-l-blue-500' : 'border-l-green-500'}`}>
            <summary className="p-4 cursor-pointer flex items-center justify-between text-sm font-bold text-neutral-400 uppercase tracking-widest list-none">
              {isSimulated ? 'Симуляция (Настройки)' : 'Железо (Настройки)'}
              <span className={`h-2 w-2 rounded-full ${status.isRunning ? 'bg-green-500' : 'bg-neutral-200'}`}></span>
            </summary>
            
            <div className="px-4 pb-4 space-y-3 pt-2">
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-neutral-400 uppercase">IP Оператора (авто)</label>
                  <input 
                    type="text" 
                    value={config.operatorIp || ''} 
                    disabled={status.isRunning}
                    placeholder="Автоопредел."
                    onChange={(e) => setConfig({...config, operatorIp: e.target.value})}
                    className={`bg-neutral-50 border border-neutral-200 p-2 text-xs rounded outline-none focus:border-blue-500 text-blue-600 ${status.isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-neutral-400 uppercase">IP БЦВМ</label>
                  <input 
                    type="text" 
                    value={config.ip} 
                    disabled={status.isRunning}
                    onChange={(e) => setConfig({...config, ip: e.target.value})}
                    className={`bg-neutral-50 border border-neutral-200 p-2 text-xs rounded outline-none focus:border-blue-500 text-blue-600 ${status.isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-neutral-400 uppercase">Порт Оператора</label>
                  <input 
                    type="number" 
                    value={config.clientLocalPort} 
                    disabled={status.isRunning}
                    onChange={(e) => setConfig({...config, clientLocalPort: parseInt(e.target.value) || 0})}
                    className={`bg-neutral-50 border border-neutral-200 p-2 text-xs rounded outline-none focus:border-blue-500 ${status.isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-neutral-400 uppercase">Порт БЦВМ</label>
                  <input 
                    type="number" 
                    value={config.udpPort} 
                    disabled={status.isRunning}
                    onChange={(e) => setConfig({...config, udpPort: parseInt(e.target.value) || 0})}
                    className={`bg-neutral-50 border border-neutral-200 p-2 text-xs rounded outline-none focus:border-blue-500 ${status.isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />
                </div>
              </div>
            </div>
          </details>

          <details className="bg-white border border-neutral-200 rounded-lg shadow-xl group border-l-4 border-l-sky-500">
            <summary className="p-4 cursor-pointer flex items-center justify-between text-sm font-bold text-sky-600 uppercase tracking-widest list-none">
              Настройки АСН (Тактировщик)
              <span className={`h-2 w-2 rounded-full ${status.isRunning ? 'bg-sky-500' : 'bg-neutral-200'}`}></span>
            </summary>
            
            <div className="px-4 pb-4 space-y-3 pt-2">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-neutral-400 uppercase">Период тактов (мс)</label>
                <input 
                  type="number" 
                  value={config.asnPeriod ?? 2000} 
                  disabled={status.isRunning}
                  onChange={(e) => setConfig({...config, asnPeriod: parseInt(e.target.value) || 0})}
                  className={`bg-neutral-50 border border-neutral-200 p-2 text-xs rounded outline-none focus:border-sky-500 text-sky-600 font-bold ${status.isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                />
                <p className="text-[9px] text-neutral-400 leading-tight">Стандартное значение: 10 мс (100 Гц)</p>
              </div>


            </div>
          </details>

          <details className="bg-white border border-neutral-200 rounded-lg shadow-xl group border-l-4 border-l-purple-500">
            <summary className="p-4 cursor-pointer flex items-center justify-between text-sm font-bold text-neutral-400 uppercase tracking-widest list-none">
              Файлы системы
              <span className={`h-2 w-2 rounded-full ${files.cyclogram && files.mission ? 'bg-purple-500' : 'bg-neutral-200'}`}></span>
            </summary>
            <div className="px-4 pb-4 space-y-3 pt-2">
              <div className="grid grid-cols-1 gap-2">
                <label className={`flex items-center justify-center gap-2 py-2 px-4 border-2 border-dashed rounded cursor-pointer transition-all ${files.mission ? 'border-purple-400 bg-purple-50' : 'border-neutral-200 hover:border-purple-400 hover:bg-purple-50'}`}>
                  <input 
                    type="file" 
                    className="hidden" 
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) setFiles(prev => ({ ...prev, mission: file.name }));
                    }} 
                  />
                  <span className="text-[10px] font-bold text-neutral-600 uppercase text-center">
                    {files.mission ? `Задание: ${files.mission}` : 'Загрузить задание (.ini)'}
                  </span>
                </label>
                <label className={`flex items-center justify-center gap-2 py-2 px-4 border-2 border-dashed rounded cursor-pointer transition-all ${files.cyclogram ? 'border-blue-400 bg-blue-50' : 'border-neutral-200 hover:border-blue-400 hover:bg-blue-50'}`}>
                  <input 
                    type="file" 
                    className="hidden" 
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) setFiles(prev => ({ ...prev, cyclogram: file.name }));
                    }} 
                  />
                  <span className="text-[10px] font-bold text-neutral-600 uppercase text-center">
                    {files.cyclogram ? `Цикл: ${files.cyclogram}` : 'Загрузить циклограмму (.ini)'}
                  </span>
                </label>
              </div>
              
              <motion.button
                whileTap={{ scale: 0.98 }}
                disabled={!files.cyclogram || !files.mission || isPayloadUpdating}
                onClick={sendFiles}
                className={`w-full py-2.5 text-xs font-bold rounded-lg transition-all shadow-md ${
                  !files.cyclogram || !files.mission 
                  ? 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                  : isPayloadUpdating 
                    ? 'bg-green-600 text-white' 
                    : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-indigo-500/10'
                }`}
              >
                {isPayloadUpdating ? 'ОТПРАВЛЕНО' : 'ОТПРАВИТЬ ФАЙЛЫ'}
              </motion.button>
            </div>
          </details>

          <details 
            className="bg-white border border-neutral-200 rounded-lg shadow-xl group border-l-4 border-l-orange-500"
          >
            <summary className="p-4 cursor-pointer flex items-center justify-between text-sm font-bold text-neutral-400 uppercase tracking-widest list-none">
              Данные и Команда
              <span className={`h-2 w-2 rounded-full ${config.command === 8 ? 'bg-orange-500 animate-pulse' : 'bg-blue-500'}`}></span>
            </summary>
            <div className="px-4 pb-4 space-y-4 pt-2">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-neutral-400 uppercase">Команда протокола</label>
                <select 
                  value={config.command} 
                  onChange={(e) => setConfig({...config, command: parseInt(e.target.value)})}
                  className="bg-neutral-50 border border-neutral-200 p-2 text-xs rounded outline-none focus:border-blue-500 text-blue-600 font-bold"
                >
                  <option value={1}>1 (ЧТЕНИЕ)</option>
                  <option value={8}>8 (ЗАПИСЬ)</option>
                </select>
              </div>

              <div className={`transition-all ${config.command !== 8 ? 'opacity-30 grayscale pointer-events-none' : ''}`}>
                <div className="grid grid-cols-2 gap-2 mb-4">
                  {payload.angles.map((angle, i) => (
                    <div key={i} className="flex flex-col gap-1">
                      <label className="text-[10px] text-neutral-400 uppercase">Мотор {i + 1}</label>
                      <input 
                        type="number" 
                        value={angle} 
                        onChange={(e) => {
                          const val = e.target.value;
                          const newAngles = [...payload.angles];
                          newAngles[i] = val;
                          setPayload({...payload, angles: newAngles});
                        }}
                        className="bg-neutral-50 border border-neutral-200 p-2 text-xs rounded outline-none focus:border-orange-500 text-orange-600 w-full font-bold"
                      />
                    </div>
                  ))}
                </div>

                <div className="flex flex-col gap-1 mb-4">
                  <label className="text-[10px] text-neutral-400 uppercase">Биты пиропатронов (8-bit)</label>
                  <div className="grid grid-cols-4 gap-2 bg-neutral-50 p-2 rounded border border-neutral-100">
                    {payload.pyro.map((bit, i) => (
                      <label key={i} className="flex flex-col items-center gap-1 cursor-pointer">
                        <input 
                          type="checkbox"
                          checked={bit}
                          onChange={(e) => {
                            const newPyro = [...payload.pyro];
                            newPyro[i] = e.target.checked;
                            setPayload({...payload, pyro: newPyro});
                          }}
                          className="accent-orange-500"
                        />
                        <span className="text-[9px] text-neutral-400">{i}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <motion.button 
                  whileTap={{ scale: 0.98 }}
                  onClick={updatePayload}
                  className={`w-full py-2 text-xs font-bold rounded transition-all shadow-lg ${
                    isPayloadUpdating 
                    ? 'bg-green-600 text-white' 
                    : 'bg-orange-600 hover:bg-orange-500 text-white shadow-orange-500/20'
                  }`}
                  disabled={config.command !== 8 || isPayloadUpdating}
                >
                  {isPayloadUpdating ? 'ОБНОВЛЕНО' : 'ОБНОВИТЬ ДАННЫЕ'}
                </motion.button>
              </div>
            </div>
          </details>

          <details 
            open={isSshDetailsOpen}
            onToggle={(e) => {
              const isOpen = (e.currentTarget as HTMLDetailsElement).open;
              setIsSshDetailsOpen(isOpen);
              localStorage.setItem(STORAGE_PREFIX + 'ssh_details_open', String(isOpen));
            }}
            className="bg-white border border-neutral-200 rounded-lg shadow-xl group border-l-4 border-l-red-500"
          >
            <summary className="p-4 cursor-pointer flex items-center justify-between text-sm font-bold text-red-500 uppercase tracking-widest list-none">
              SSH Деплой (БЦВМ)
              <span className={`h-2 w-2 rounded-full ${isSshDeploying || isSshCompiling ? 'bg-red-500 animate-pulse' : 'bg-neutral-200'}`}></span>
            </summary>
            <div className="px-4 pb-4 space-y-3 pt-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] text-neutral-400 uppercase font-bold block mb-1">IP-Адрес БЦВМ</label>
                  <input
                    type="text"
                    value={sshHost}
                    onChange={(e) => setSshHost(e.target.value)}
                    className="w-full text-xs p-1.5 bg-neutral-50 border border-neutral-200 rounded focus:border-red-500 outline-none"
                    placeholder="192.168.17.246"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-neutral-400 uppercase font-bold block mb-1">Пользователь</label>
                  <input
                    type="text"
                    value={sshUsername}
                    onChange={(e) => setSshUsername(e.target.value)}
                    className="w-full text-xs p-1.5 bg-neutral-50 border border-neutral-200 rounded focus:border-red-500 outline-none"
                    placeholder="root"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] text-neutral-400 uppercase font-bold block mb-1">Пароль (SSH)</label>
                  <input
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    className="w-full text-xs p-1.5 bg-neutral-50 border border-neutral-200 rounded focus:border-red-500 outline-none font-mono"
                    placeholder="Пароль"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-neutral-400 uppercase font-bold block mb-1">Удаленный путь</label>
                  <input
                    type="text"
                    value={sshTargetPath}
                    onChange={(e) => setSshTargetPath(e.target.value)}
                    className="w-full text-xs p-1.5 bg-neutral-50 border border-neutral-200 rounded focus:border-red-500 outline-none"
                    placeholder="/home/yav_client"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <motion.button 
                  whileTap={{ scale: 0.98 }}
                  onClick={handleSshCompile}
                  disabled={isSshCompiling || isSshDeploying}
                  className={`w-full py-2.5 text-xs font-bold rounded-lg transition-all shadow-md ${
                    isSshCompiling 
                    ? 'bg-neutral-100 text-neutral-400 cursor-not-allowed' 
                    : 'bg-neutral-800 hover:bg-neutral-700 text-white shadow-neutral-500/10'
                  }`}
                >
                  {isSshCompiling ? 'ВЫПОЛНЯЕТСЯ СБОРКА...' : 'СКОМПИЛИРОВАТЬ ДЛЯ ARM'}
                </motion.button>

                <motion.button 
                  whileTap={{ scale: 0.98 }}
                  onClick={handleSshDeploy}
                  disabled={isSshCompiling || isSshDeploying}
                  className={`w-full py-2.5 text-xs font-bold rounded-lg transition-all shadow-md ${
                    isSshDeploying 
                    ? 'bg-neutral-100 text-neutral-400 cursor-not-allowed' 
                    : 'bg-red-600 hover:bg-red-500 text-white shadow-red-500/15'
                  }`}
                >
                  {isSshDeploying ? 'ОТПРАВКА...' : 'ОТПРАВИТЬ ПО SSH'}
                </motion.button>
              </div>

              {isSshCompiling && (
                <div className="mt-2 space-y-1 bg-neutral-50 p-2.5 rounded-lg border border-neutral-200">
                  <div className="flex justify-between text-[11px] font-semibold text-neutral-700">
                    <span className="flex items-center gap-1.5 text-blue-600">
                      <Activity size={12} className="animate-spin text-blue-500" />
                      {compileProgress.stage || 'Выполнение сборки...'}
                    </span>
                    <span className="text-neutral-500">{compileProgress.pct}%</span>
                  </div>
                  <div className="w-full bg-neutral-200 h-1.5 rounded-full overflow-hidden">
                    <motion.div 
                      className="bg-blue-600 h-full rounded-full"
                      initial={{ width: '0%' }}
                      animate={{ width: `${compileProgress.pct}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                </div>
              )}

              {sshDeployOutput && (
                <div className="mt-2 text-[10px] font-mono whitespace-pre-wrap bg-neutral-900 text-neutral-300 p-3 rounded-lg max-h-56 overflow-y-auto leading-relaxed border border-neutral-800">
                  {sshDeployOutput}
                  <div ref={sshLogEndRef} />
                </div>
              )}
            </div>
          </details>

          {/* Version Panel */}
          <div className="bg-white border border-neutral-200 rounded-lg shadow-xl p-4">
               <label className="text-[10px] text-neutral-400 uppercase mb-2 block">Режим работы системы</label>
               <div className="flex flex-col gap-1 bg-neutral-100 p-1 rounded-lg">
                  <div className="flex gap-1">
                    <button 
                        onClick={() => toggleDevelopmentMode('cpp')}
                        className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all ${status.simMode === 'cpp' ? 'bg-white shadow text-blue-600' : 'text-neutral-400 hover:text-neutral-600'}`}
                    >
                        C++ SYSTEM
                    </button>
                  </div>
                  <button 
                    onClick={() => toggleDevelopmentMode('hw')}
                    className={`w-full py-1.5 text-[10px] font-bold rounded-md transition-all ${status.simMode === 'hw' ? 'bg-white shadow text-green-600' : 'text-neutral-400 hover:text-neutral-600'}`}
                  >
                    РЕАЛЬНОЕ ЖЕЛЕЗО
                  </button>
               </div>
          </div>
        </div>

        <div className="lg:col-span-3 bg-white border border-neutral-200 rounded-lg shadow-xl overflow-hidden flex flex-col h-full">
          <div className="bg-neutral-50 px-4 py-2 text-xs font-bold border-b border-neutral-200 flex justify-between items-center sticky top-0 z-20 shrink-0">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-2 text-neutral-600">
                <Terminal size={14} className="text-blue-500" />
                СИСТЕМНЫЙ ЖУРНАЛ СВЯЗИ
                {isTesting && (
                  <motion.span 
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex items-center gap-2 px-2 py-0.5 bg-blue-100 text-blue-600 rounded-full text-[9px] font-bold"
                  >
                    <Activity size={10} className="animate-pulse" />
                    ПРОВЕРКА СОЕДИНЕНИЯ...
                  </motion.span>
                )}
                {isPaused && (
                  <span className="flex items-center gap-1.5 px-1.5 py-0.5 bg-orange-100 text-orange-600 rounded-full text-[9px] animate-pulse">
                    ПАУЗА
                  </span>
                )}
              </span>
              <button 
                onClick={fetchFileLogs}
                className="text-[10px] text-blue-500 hover:text-blue-700 uppercase tracking-widest border border-blue-200 px-2 py-0.5 rounded bg-blue-50 font-bold"
              >
                ФАЙЛ ЛОГОВ
              </button>
              {status.simMode === 'cpp' && (
                <button 
                  onClick={fetchNativeLogs}
                  className="text-[10px] text-orange-500 hover:text-orange-700 uppercase tracking-widest border border-orange-200 px-2 py-0.5 rounded bg-orange-50 font-bold"
                >
                  ЛОКАЛЬНЫЙ ЛОГ C++
                </button>
              )}
              <button 
                onClick={togglePause}
                className={`flex items-center gap-1.5 text-[10px] transition-all border px-2 py-0.5 rounded shadow-sm ${
                  isPaused ? 'bg-blue-600 text-white' : 'bg-white text-neutral-500'
                }`}
              >
                {isPaused ? 'ПРОДОЛЖИТЬ' : 'ПАУЗА'}
              </button>
              <button onClick={clearLogs} className="text-[10px] text-neutral-400 hover:text-red-500 uppercase tracking-widest border border-neutral-200 px-2 py-0.5 rounded bg-white font-bold">ОЧИСТИТЬ ЖУРНАЛ</button>
            </div>
            <span className="text-neutral-300">v1.5.0</span>
          </div>

          <div className="grid grid-cols-[120px_120px_120px_60px_180px_1fr] gap-4 px-4 py-2 border-b border-neutral-200 bg-neutral-100 text-[10px] font-bold text-neutral-500 uppercase tracking-wider shrink-0">
            <div>Время</div>
            <div>Отправитель</div>
            <div>Получатель</div>
            <div>SIZE</div>
            <div>HEX</div>
            <div>Сообщение</div>
          </div>

          <div className="flex-1 flex flex-col overflow-hidden min-h-0 bg-white relative">
            {isTesting && (
              <motion.div 
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                className="absolute top-0 left-0 right-0 h-0.5 bg-blue-500 origin-left z-10"
                transition={{ duration: 3, ease: "linear" }}
              />
            )}
            {showFileLogs ? (
              <div className="flex-1 overflow-auto p-4 bg-neutral-900 text-green-400 font-mono text-xs relative">
                <button 
                  onClick={() => setShowFileLogs(false)}
                  className="absolute top-2 right-2 px-2 py-1 bg-neutral-700 text-white rounded hover:bg-neutral-600 z-10"
                >
                  ЗАКРЫТЬ
                </button>
                <div className="whitespace-pre-wrap">{fileLogs}</div>
              </div>
            ) : showNativeLogs ? (
              <div className="flex-1 overflow-auto p-4 bg-neutral-900 text-orange-300 font-mono text-xs relative">
                <div className="flex justify-between items-center mb-4 sticky top-0 bg-neutral-900 py-2">
                  <span className="text-orange-500 font-bold uppercase tracking-widest">Локальный вывод C++ процессов (stdout/stderr)</span>
                  <div className="flex gap-2">
                    <button 
                      onClick={fetchNativeLogs}
                      className="px-2 py-1 bg-neutral-700 text-white rounded hover:bg-neutral-600 font-bold"
                    >
                      ОБНОВИТЬ
                    </button>
                    <button 
                      onClick={() => setShowNativeLogs(false)}
                      className="px-2 py-1 bg-neutral-700 text-white rounded hover:bg-neutral-600 font-bold"
                    >
                      ЗАКРЫТЬ
                    </button>
                  </div>
                </div>
                <div className="space-y-1">
                  {nativeLogs.length === 0 ? (
                    <div className="text-neutral-500 italic">Логи пока пусты...</div>
                  ) : (
                    nativeLogs.map((log, i) => <div key={i} className="whitespace-pre-wrap">{log}</div>)
                  )}
                </div>
              </div>
            ) : (
              <div ref={scrollRef} onScroll={() => handleScroll(scrollRef, shouldAutoScroll)} className="flex-1 overflow-y-auto p-4 space-y-0.5">
                {(isPaused && pausedLogsSnapshot ? pausedLogsSnapshot : status.logs).map((log, i) => renderLogEntry(log, i))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
