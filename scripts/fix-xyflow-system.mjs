import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const bundledPath = path.join(root, 'node_modules', '@xyflow', 'react', 'node_modules', '@xyflow', 'system');
const rootSystemPath = path.join(root, 'node_modules', '@xyflow', 'system');

function fileContainsExport(filePath, exportName) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.includes(`export { ${exportName}`) || content.includes(`export { ${exportName},`) || content.includes(`export { ${exportName} }`);
}

function checkBundledSystemMissingExport() {
  const bundledIndex = path.join(bundledPath, 'dist', 'esm', 'index.js');
  if (!fs.existsSync(bundledIndex)) {
    return false;
  }
  return !fileContainsExport(bundledIndex, 'handleAttributionWarning');
}

function ensureRootSystemAvailable() {
  const rootIndex = path.join(rootSystemPath, 'dist', 'esm', 'index.js');
  if (!fs.existsSync(rootIndex)) {
    console.log('[fix-xyflow-system] Root @xyflow/system missing, installing...');
    execSync('npm install @xyflow/system@0.0.82 --no-save', { stdio: 'inherit', cwd: root });
  }
}

function fixBundledSystem() {
  ensureRootSystemAvailable();

  const rootIndex = path.join(rootSystemPath, 'dist', 'esm', 'index.js');
  if (!fs.existsSync(rootIndex)) {
    console.error('[fix-xyflow-system] Root @xyflow/system still missing after install.');
    process.exit(1);
  }

  if (fs.existsSync(bundledPath)) {
    const isSymlink = fs.lstatSync(bundledPath).isSymbolicLink();
    if (isSymlink) {
      console.log('[fix-xyflow-system] @xyflow/system is already symlinked.');
      return;
    }

    console.log('[fix-xyflow-system] Removing bundled @xyflow/system and replacing with symlink...');
    fs.rmSync(bundledPath, { recursive: true, force: true });
  } else {
    console.log('[fix-xyflow-system] Creating symlink for missing bundled @xyflow/system...');
  }

  fs.mkdirSync(path.dirname(bundledPath), { recursive: true });
  fs.symlinkSync(rootSystemPath, bundledPath, 'junction');
  console.log('[fix-xyflow-system] Symlinked @xyflow/react/node_modules/@xyflow/system -> ../@xyflow/system');
}

const needsFix = checkBundledSystemMissingExport();
if (!needsFix) {
  console.log('[fix-xyflow-system] No fix needed.');
  process.exit(0);
}

console.log('[fix-xyflow-system] Detected broken @xyflow/system bundled in @xyflow/react.');
fixBundledSystem();
