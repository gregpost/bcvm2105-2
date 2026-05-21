import { execSync } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

const isArm = process.argv.includes('--arm');
const noYals = process.argv.includes('--no-yals');
const buildArg = isArm ? ' --arm' : '';

// Function to update PATH with local binary locations so scripts can find compilers easily
function updateProcessPath() {
    const pathsToAdd = [
        path.join(homedir(), 'local', 'arm-toolchain', 'bin'),
        path.join(homedir(), 'local', 'gcc-arm-10.3-2021.07-mingw-w64-i686-arm-none-linux-gnueabihf', 'bin'),
        path.join(homedir(), 'miniconda3', 'bin')
    ];
    for (const p of pathsToAdd) {
        if (existsSync(p)) {
            process.env.PATH = `${p}${path.delimiter}${process.env.PATH}`;
        }
    }
}

updateProcessPath();

function getBashCommand(): string {
    if (process.platform !== 'win32') {
        return 'bash';
    }
    // Check common Git Bash locations
    const paths = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        'C:\\Git\\bin\\bash.exe'
    ];
    for (const p of paths) {
        if (existsSync(p)) {
            return `"${p}"`;
        }
    }
    // Try to find bash/sh in PATH, but avoid WSL's C:\Windows\System32\bash.exe
    try {
        const whereBash = execSync('where bash', { encoding: 'utf8' }).split('\r\n');
        for (const wb of whereBash) {
            const trimmed = wb.trim();
            if (trimmed && !trimmed.toLowerCase().includes('windows\\system32')) {
                return `"${trimmed}"`;
            }
        }
    } catch (e) {}
    
    try {
        const whereSh = execSync('where sh', { encoding: 'utf8' }).split('\r\n');
        for (const ws of whereSh) {
            const trimmed = ws.trim();
            if (trimmed) {
                return `"${trimmed}"`;
            }
        }
    } catch (e) {}

    return 'bash'; // fallback
}

// Automatically check and run gpp_installer if compiling for ARM and no arm compilers present
if (isArm) {
    const hasCompiler = () => {
        const checkCmd = (cmd: string) => {
            try {
                execSync(`${cmd} --version`, { stdio: 'ignore' });
                return true;
            } catch {
                return false;
            }
        };
        const hasGcc = checkCmd('arm-linux-gnueabihf-g++') || checkCmd('arm-none-linux-gnueabihf-g++');
        if (!hasGcc) return false;
        if (process.platform === 'win32') {
            return checkCmd('ninja') || checkCmd('make') || checkCmd('mingw32-make');
        }
        return true;
    };

    if (!hasCompiler()) {
        console.log('🔍 ARM кросс-компилятор не обнаружен в PATH. Запуск подготовки...');
        try {
            execSync('npx tsx gpp_installer.ts', { stdio: 'inherit' });
            // Update PATH environment in current process again so we pick up the newly installed compiler
            updateProcessPath();
        } catch (e) {
            console.error('⚠️ Предупреждение: Ошибка в процессе подготовки компилятора.');
        }
    }
}

const bashCmd = getBashCommand();
let hasError = false;

function runBuild(dir: string) {
    console.log(`\n--- Running build.sh in ${dir}${buildArg} ---`);
    const fullPath = path.join(process.cwd(), dir);
    if (!existsSync(path.join(fullPath, 'build.sh'))) {
        console.error(`Error: build.sh not found in ${dir}`);
        hasError = true;
        return;
    }
    try {
        execSync(`${bashCmd} build.sh${buildArg}`, { 
            cwd: fullPath,
            stdio: 'inherit',
            env: { ...process.env }
        });
    } catch (e) {
        console.error(`Error: Failed building module ${dir}`);
        hasError = true;
    }
}

runBuild('cpp_system/bcvm');
if (!noYals) {
    runBuild('cpp_system/yals');
}
runBuild('cpp_system/asn');

if (hasError) {
    console.error('\n❌ Ошибки сборки! Один или несколько модулей завершились неудачно.');
    process.exit(1);
} else {
    console.log('\n✨ Все модули успешно скомпилированы!');
}
