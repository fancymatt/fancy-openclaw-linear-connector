import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// Decrypt agents.json
const key = Buffer.from(
  fs.readFileSync('/home/fancymatt/.openclaw/secrets/linear-connector-encryption-key', 'utf8').trim(),
  'base64'
);
const raw = JSON.parse(fs.readFileSync('/home/fancymatt/Code/repos/fancy-openclaw-linear-connector/agents.json', 'utf8'));
const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
const plain = JSON.parse(Buffer.concat([decipher.update(Buffer.from(raw.ct, 'base64')), decipher.final()]).toString('utf8'));

const agents = plain.agents || [];
const aiAgent = agents.find(a => a.name === 'ai');
if (!aiAgent || !aiAgent.accessToken) {
  console.error('FATAL: could not find ai agent access token');
  process.exit(1);
}

console.log(`Using token for agent: ${aiAgent.name} (${aiAgent.linearUserId})`);

// Run the fix script from the connector repo
const fixScript = '/home/fancymatt/.openclaw/containers/workflow/config/shared/scripts/inf-71-fix-state-labels.mjs';
const repoDir = '/home/fancymatt/Code/repos/fancy-openclaw-linear-connector';

const child = spawn('node', [fixScript], {
  cwd: repoDir,
  env: { ...process.env, LINEAR_OAUTH_TOKEN: aiAgent.accessToken },
  stdio: ['inherit', 'inherit', 'inherit'],
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
