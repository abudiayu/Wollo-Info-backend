/**
 * Run this once to install missing backend dependencies.
 * Usage: node install-deps.js
 */
const { execSync } = require('child_process');

const deps = ['multer'];

console.log('Installing:', deps.join(', '));
try {
  execSync(`npm install ${deps.join(' ')} --save`, {
    stdio: 'inherit',
    cwd: __dirname,
  });
  console.log('\n✅  Done. You can now run: nodemon server.js');
} catch (err) {
  console.error('Install failed:', err.message);
  console.log('\nTry manually in your terminal:');
  console.log(`  cd "${__dirname}"`);
  console.log(`  npm install ${deps.join(' ')}`);
}
