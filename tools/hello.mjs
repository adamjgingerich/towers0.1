import { writeFileSync } from 'node:fs';

writeFileSync('c:/PROG/towers/tools/hello.txt', `node ${process.version} cwd ${process.cwd()}\n`);
console.log('hello written');
