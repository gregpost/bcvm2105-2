import { execSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, createWriteStream, readdirSync, statSync, renameSync, rmdirSync } from 'fs';
import { homedir, arch } from 'os';
import { get } from 'https';
import path from 'path';

// Disable TLS verification for node downloads to handle self-signed certificates and decryption proxies
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const TEMP_DIR = path.join(homedir(), '.gpp-tmp');

function checkCommand(cmd: string): boolean {
    try {
        execSync(`${cmd} --version`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function hasGpp(): boolean {
    if (checkCommand('g++') && checkCommand('cmake') && checkCommand('make')) {
        return true;
    }
    
    // Also check if conda bin is already in PATH or if miniconda exists
    const condaBin = path.join(homedir(), 'miniconda3', 'bin');
    if (existsSync(path.join(condaBin, 'g++')) || existsSync(path.join(condaBin, 'x86_64-conda-linux-gnu-g++'))) {
        process.env.PATH = `${condaBin}${path.delimiter}${process.env.PATH}`;
        if (checkCommand('g++') && checkCommand('cmake') && checkCommand('make')) {
            return true;
        }
    }
    return false; 
}

function hasArmCompiler(): boolean {
    // Check standard PATH first
    if (checkCommand('arm-linux-gnueabihf-g++') || checkCommand('arm-none-linux-gnueabihf-g++')) {
        if (process.platform === 'win32') {
            return checkCommand('ninja') || checkCommand('make') || checkCommand('mingw32-make');
        }
        return true;
    }
    
    // Check locally installed custom arm-toolchain bin folders
    const pathsToCheck = [
        path.join(homedir(), 'local', 'arm-toolchain', 'bin'),
        path.join(homedir(), 'local', 'gcc-arm-10.3-2021.07-mingw-w64-i686-arm-none-linux-gnueabihf', 'bin')
    ];
    
    for (const p of pathsToCheck) {
        if (existsSync(p)) {
            process.env.PATH = `${p}${path.delimiter}${process.env.PATH}`;
            if (checkCommand('arm-linux-gnueabihf-g++') || checkCommand('arm-none-linux-gnueabihf-g++')) {
                if (process.platform === 'win32') {
                    return checkCommand('ninja') || checkCommand('make') || checkCommand('mingw32-make');
                }
                return true;
            }
        }
    }
    
    return false;
}

async function download(url: string, dest: string): Promise<void> {
    console.log(`📡 Attempting download from ${url}...`);
    
    if (existsSync(dest)) {
        try { rmSync(dest, { force: true }); } catch (e) {}
    }

    if (process.platform === 'win32') {
        // Try curl since it natively supports bypassing SSL errors with -k/--insecure
        try {
            console.log('⚡ Trying download via system curl (with SSL bypass)...');
            execSync(`curl -L -k "${url}" -o "${dest}"`, { stdio: 'inherit' });
            if (existsSync(dest) && statSync(dest).size > 1000) {
                console.log('✅ Successfully downloaded using curl!');
                return;
            }
        } catch (e) {
            console.log('⚠️ System curl failed or returned error, attempting PowerShell...');
        }

        // Try PowerShell with ServicePointManager settings for TLS 1.2/1.3 and ignore ssl
        try {
            console.log('⚡ Trying download via PowerShell WebClient (with TLS support)...');
            const psCmd = `
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13;
                [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true };
                $webClient = New-Object System.Net.WebClient;
                $webClient.Headers.Add('User-Agent', 'Mozilla/5.0');
                $webClient.DownloadFile('${url}', '${dest}');
            `.replace(/\s+/g, ' ').trim();
            execSync(`powershell -Command "${psCmd}"`, { stdio: 'inherit' });
            if (existsSync(dest) && statSync(dest).size > 1000) {
                console.log('✅ Successfully downloaded using PowerShell WebClient!');
                return;
            }
        } catch (e) {
            console.log('⚠️ PowerShell WebClient failed, trying PowerShell Invoke-WebRequest...');
        }

        try {
            const psCmd2 = `
                [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::Tls12 -bor [Net.SecurityProtocolType]::Tls13;
                [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true };
                Invoke-WebRequest -Uri '${url}' -OutFile '${dest}' -UseBasicParsing -SkipCertificateCheck -ErrorAction Stop;
            `.replace(/\s+/g, ' ').trim();
            execSync(`powershell -Command "${psCmd2}"`, { stdio: 'inherit' });
            if (existsSync(dest) && statSync(dest).size > 1000) {
                console.log('✅ Successfully downloaded using PowerShell Invoke-WebRequest!');
                return;
            }
        } catch (e) {
            console.log('⚠️ PowerShell Invoke-WebRequest failed.');
        }
    } else {
        // Non-windows environments (Linux/Mac)
        try {
            console.log('⚡ Trying download via curl...');
            execSync(`curl -L -k "${url}" -o "${dest}"`, { stdio: 'inherit' });
            if (existsSync(dest) && statSync(dest).size > 1000) {
                console.log('✅ Successfully downloaded using curl!');
                return;
            }
        } catch (e) {
            try {
                console.log('⚡ curl failed, trying wget...');
                execSync(`wget --no-check-certificate "${url}" -O "${dest}"`, { stdio: 'inherit' });
                if (existsSync(dest) && statSync(dest).size > 1000) {
                    console.log('✅ Successfully downloaded using wget!');
                    return;
                }
            } catch (e2) {}
        }
    }

    console.log('🌐 System tools unavailable or failed. Falling back to Node.js HTTPS module (ignoring TLS)...');
    return new Promise((resolve, reject) => {
        const file = createWriteStream(dest);
        const options = {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            },
            rejectUnauthorized: false
        };
        
        function handleRequest(targetUrl: string) {
            get(targetUrl, options, res => {
                const { statusCode, headers } = res;
                if (statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308) {
                    if (headers.location) {
                        handleRequest(headers.location);
                        return;
                    }
                }
                if (statusCode !== 200) {
                    reject(new Error(`Failed to download from ${targetUrl}: ${statusCode}`));
                    return;
                }
                res.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
            }).on('error', err => {
                file.close();
                reject(err);
            });
        }
        
        handleRequest(url);
    });
}

async function installViaConda(): Promise<boolean> {
    console.log('📦 Starting native g++ installation via Conda...');
    const url = arch() === 'x64' 
        ? 'https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh'
        : 'https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-aarch64.sh';
    
    const installer = path.join(TEMP_DIR, 'miniconda.sh');
    if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
    
    console.log(`📥 Downloading installer from ${url}...`);
    await download(url, installer);
    console.log('✅ Download complete.');

    console.log('⚙️ Installing Miniconda to ~/miniconda3...');
    execSync(`bash ${installer} -b -p ${homedir()}/miniconda3 -f`);
    
    console.log('🔧 Installing gxx_linux-64 and cmake via Conda...');
    const condaPath = `${homedir()}/miniconda3/bin/conda`;
    
    try {
        console.log('📜 Accepting Terms of Service...');
        execSync(`${condaPath} tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main || true`);
        execSync(`${condaPath} tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r || true`);
    } catch (e) {
        console.log('⚠️ Could not accept TOS, continuing anyway...');
    }
    
    execSync(`${condaPath} install -c conda-forge gxx_linux-64 cmake make -y`);
    
    const condaBin = path.join(homedir(), 'miniconda3', 'bin');
    const prefixedGpp = path.join(condaBin, 'x86_64-conda-linux-gnu-g++');
    const standardGpp = path.join(condaBin, 'g++');
    
    if (existsSync(prefixedGpp) && !existsSync(standardGpp)) {
        console.log('🔗 Creating symlink for g++...');
        try {
            execSync(`ln -s ${prefixedGpp} ${standardGpp}`);
        } catch (e) {
            console.log('⚠️ Could not create symlink');
        }
    }

    process.env.PATH = `${condaBin}${path.delimiter}${process.env.PATH}`;
    console.log('✅ g++ установлен через Conda');
    return true;
}

async function installArmCompiler(): Promise<boolean> {
    console.log('🔍 Проверка наличия ARM кросс-компилятора...');
    
    if (hasArmCompiler()) {
        console.log('✅ ARM кросс-компилятор уже установлен и настроен.');
        return true;
    }

    if (process.platform === 'win32') {
        console.log('📦 Обнаружена ОС Windows. Проверяем установку Arm GNU Toolchain...');
        const url = 'https://developer.arm.com/-/media/Files/downloads/gnu/15.2.rel1/binrel/arm-gnu-toolchain-15.2.rel1-mingw-w64-i686-arm-none-linux-gnueabihf.zip';
        const targetDir = path.join(homedir(), 'local');
        const zipPath = path.join(TEMP_DIR, 'arm-toolchain.zip');
        const extractDir = path.join(targetDir, 'arm-toolchain');
        const binDir = path.join(extractDir, 'bin');
        const gccExe = path.join(binDir, 'arm-none-linux-gnueabihf-g++.exe');

        if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
        if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

        const ensureNinja = async (bDir: string): Promise<void> => {
            const ninjaExe = path.join(bDir, 'ninja.exe');
            if (!existsSync(ninjaExe)) {
                console.log('⚡ Настраиваем встроенный Ninja для сборки на Windows...');
                const ninjaZip = path.join(TEMP_DIR, 'ninja.zip');
                const ninjaUrl = 'https://github.com/ninja-build/ninja/releases/download/v1.12.1/ninja-win.zip';
                try {
                    await download(ninjaUrl, ninjaZip);
                    console.log('✅ Архив Ninja успешно скачан. Распаковка...');
                    try {
                        execSync(`unzip -o "${ninjaZip}" -d "${bDir}"`, { stdio: 'ignore' });
                    } catch (e) {
                        execSync(`powershell -Command "Expand-Archive -Path '${ninjaZip}' -DestinationPath '${bDir}' -Force"`);
                    }
                    if (existsSync(ninjaExe)) {
                        console.log('✅ Исполняемый файл ninja.exe успешно добавлен в bin!');
                    }
                } catch (nErr: any) {
                    console.warn('⚠️ Ошибка при установке Ninja:', nErr.message);
                }
            }
        };

        // If compiler is already installed, verify Ninja and finish
        if (existsSync(gccExe)) {
            console.log('✅ Arm GNU Toolchain уже распакован.');
            await ensureNinja(binDir);
            process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
            return true;
        }

        console.log(`📥 Скачивание архива с GCC ARM Toolchain (${url})...`);
        try {
            await download(url, zipPath);
            console.log('✅ Архив успешно скачан. Распаковка архива (может занять некоторое время)...');
            
            if (existsSync(extractDir)) {
                try { rmSync(extractDir, { recursive: true, force: true }); } catch (e) {}
            }
            mkdirSync(extractDir, { recursive: true });

            try {
                console.log('⚡ Пробуем извлечь с помощью bult-in unzip...');
                execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'ignore' });
            } catch (e) {
                console.log('⚡ Инструмент unzip не найден, используем PowerShell Expand-Archive...');
                execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`);
            }
            
            console.log('✅ Распаковка завершена.');

            const findBinPath = (dir: string): string | null => {
                if (existsSync(path.join(dir, 'bin'))) {
                    return path.join(dir, 'bin');
                }
                try {
                    const subdirs = readdirSync(dir).filter(f => statSync(path.join(dir, f)).isDirectory());
                    for (const sd of subdirs) {
                        const res = findBinPath(path.join(dir, sd));
                        if (res) return res;
                    }
                } catch (e) {}
                return null;
            };

            const foundBinDir = findBinPath(extractDir);
            if (foundBinDir) {
                console.log(`🔗 Найдена папка с исполняемыми файлами: ${foundBinDir}`);
                const innerDir = path.dirname(foundBinDir);
                if (innerDir !== extractDir) {
                    console.log('📂 Приведение структуры директорий к стандартному виду...');
                    readdirSync(innerDir).forEach(file => {
                        const oldPath = path.join(innerDir, file);
                        const newPath = path.join(extractDir, file);
                        renameSync(oldPath, newPath);
                    });
                    try { rmdirSync(innerDir); } catch(e) {}
                }
                
                await ensureNinja(binDir);
                
                console.log('✅ ARM кросс-компилятор успешно настроен локально!');
                process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
                return true;
            } else {
                console.error('❌ Ошибка: В распакованном архиве не найдена папка bin!');
                return false;
            }
        } catch (err: any) {
            console.error('❌ Не удалось скачать или распаковать ARM компилятор для Windows:', err.message);
            return false;
        }
    } else {
        console.log('📦 Начинаем установку ARM кросс-компилятора для Linux...');
        try {
            console.log('📡 Обновление пакетов и установка gcc/g++-arm-linux-gnueabihf через apt...');
            execSync('sudo apt-get update && sudo apt-get install -y gcc-arm-linux-gnueabihf g++-arm-linux-gnueabihf cmake make', { stdio: 'inherit' });
            return true;
        } catch (e: any) {
            console.log('⚠️ Не удалось установить через apt-get (нет прав sudo или не-Debian ОС).');
            console.log('🛠️ Пробуем установить через Conda...');
            try {
                const condaBin = path.join(homedir(), 'miniconda3', 'bin');
                const condaPath = existsSync(path.join(condaBin, 'conda')) ? path.join(condaBin, 'conda') : 'conda';
                execSync(`${condaPath} install -c conda-forge gxx_linux-armhf cmake make -y`, { stdio: 'inherit' });
                return true;
            } catch (ce: any) {
                console.error('❌ Не удалось установить ARM компилятор через Conda:', ce.message);
                return false;
            }
        }
    }
}

async function main(): Promise<void> {
    console.log('🔍 Проверка готовности окружения компиляции...');
    
    // 1. Ensure basic g++ toolchain
    if (!hasGpp()) {
        console.log('🔧 Native g++/cmake/make не найдены. Пытаемся установить...');
        if (process.platform === 'win32') {
            console.log('⚠️ На Windows, пожалуйста, установите Build Tools C++ или MinGW.');
        } else {
            try {
                execSync('sudo apt-get update && sudo apt-get install -y build-essential cmake make', { stdio: 'inherit' });
            } catch (e) {
                await installViaConda();
            }
        }
    } else {
        console.log('✅ Базовый компилятор g++ и вспомогательные инструменты уже установлены.');
    }

    // 2. Ensure ARM cross-compiler is installed
    const armSuccess = await installArmCompiler();
    if (armSuccess) {
        console.log('🚀 Подготовка ARM кросс-компилятора успешно завершена!');
    } else {
        console.error('❌ Не удалось завершить настройку ARM кросс-компилятора.');
        process.exit(1);
    }
}

main().catch(e => {
    console.error('❌ Исключение при подготовке компилятора:', e.message);
    process.exit(1);
});
