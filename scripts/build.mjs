import { build } from 'esbuild';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const outFile = path.join(root, 'dist', 'pc-mcp.mjs');

await mkdir(path.dirname(outFile), { recursive: true });


const banner = `import { createRequire as __pcmcp_createRequire } from 'node:module';
import { fileURLToPath as __pcmcp_fileURLToPath } from 'node:url';
import { dirname as __pcmcp_dirname } from 'node:path';
const require = __pcmcp_createRequire(import.meta.url);
const __filename = __pcmcp_fileURLToPath(import.meta.url);
const __dirname = __pcmcp_dirname(__filename);
`;

const started = Date.now();
const result = await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node18'],
  banner: { js: banner },
  define: { 'process.env.PC_MCP_BUILD_VERSION': JSON.stringify(pkg.version) },
  legalComments: 'none',
  sourcemap: false,
  minify: false,
  treeShaking: true,
  logLevel: 'warning',
  metafile: true
});

await chmod(outFile, 0o755).catch(() => {});

const size = (await stat(outFile)).size;
const deps = Object.keys(result.metafile.inputs).filter((f) => f.includes('node_modules')).length;
await writeFile(path.join(root, 'dist', 'build-info.json'), JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString(), bytes: size, bundledModules: deps }, null, 2) + '\n');

console.log(`dist/pc-mcp.mjs pronto: ${(size / 1024).toFixed(0)} KB, ${deps} modulos embutidos, ${Date.now() - started}ms`);
