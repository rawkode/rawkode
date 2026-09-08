import {cp, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
await mkdir('public/diagram-assets', {recursive:true});
await cp('node_modules/@excalidraw/excalidraw/dist/prod/fonts', 'public/diagram-assets/fonts', {recursive:true});
const notices=[];
async function scan(directory) {
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const path=`${directory}/${entry.name}`;
    if(entry.name.startsWith('@')) { await scan(path); continue; }
    try {
      const pkg=JSON.parse(await readFile(`${path}/package.json`,'utf8'));
      let notice=`${pkg.name} ${pkg.version}\n${pkg.license ?? ''}\n${typeof pkg.repository==='string'?pkg.repository:pkg.repository?.url ?? ''}\n`;
      for(const file of await readdir(path)) if(/^(license|copying|notice|third.party.notices)/i.test(file)) {
        try { notice+='\n'+await readFile(`${path}/${file}`,'utf8'); } catch {}
      }
      notices.push(notice);
    } catch {}
  }
}
await scan('node_modules');
await writeFile('public/licenses/THIRD-PARTY-NOTICES.txt',notices.join('\n\n'+'='.repeat(72)+'\n\n'));
