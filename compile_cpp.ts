
import { execSync } from 'child_process';
import { homedir } from 'os';
import { existsSync } from 'fs';
import path from 'path';

const CONDA_BIN = `${homedir()}/miniconda3/bin`;
process.env.PATH = `${CONDA_BIN}:${process.env.PATH}`;

function run(cmd: string) {
    console.log(`🚀 Running: ${cmd}`);
    try {
        const out = execSync(cmd, { stdio: 'inherit' });
    } catch (e) {
        console.error(`❌ Failed: ${cmd}`);
        process.exit(1);
    }
}

async function main() {
    console.log('⚒️ Starting C++ compilation...');
    
    // Client
    console.log('\n--- Building YAV Client ---');
    run('x86_64-conda-linux-gnu-g++ cpp_system/bcvm/main.cpp -o cpp_system/bcvm/yav_client -pthread -O3');
    
    // Server
    console.log('\n--- Building YALS Simulator ---');
    run('x86_64-conda-linux-gnu-g++ cpp_system/yals/main.cpp -o cpp_system/yals/yals_simulator -pthread -O3');
    
    // ASN
    console.log('\n--- Building ASN Simulator ---');
    run('x86_64-conda-linux-gnu-g++ cpp_system/asn/main.cpp -o cpp_system/asn/asn_simulator -pthread -O3');
    
    console.log('\n✅ Compilation finished successfully!');
    console.log('Client: cpp_system/bcvm/yav_client');
    console.log('Server: cpp_system/yals/yals_simulator');
    console.log('ASN: cpp_system/asn/asn_simulator');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
