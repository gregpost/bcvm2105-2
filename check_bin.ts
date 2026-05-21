
import { readdirSync } from 'fs';
import { homedir } from 'os';
const binDir = `${homedir()}/miniconda3/bin`;
try {
    const files = readdirSync(binDir);
    console.log(files.filter(f => f.includes('g++')));
} catch (e) {
    console.log('Dir not found');
}
