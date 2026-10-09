import { readdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const roots = ['bot/dist', 'packages/contracts/dist', 'packages/transport/dist'];
const files = {};
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(name);
    else if (entry.isFile()) files[name] = (await readFile(name)).toString('base64');
  }
}
for (const root of roots) await walk(root);
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const packagesSha = execFileSync('git', ['-C', 'packages', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await writeFile(path.resolve('deployment.json'), JSON.stringify({ sha, packagesSha, files }));
