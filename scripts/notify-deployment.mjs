import { createHmac } from 'node:crypto';
const targets = JSON.parse(process.env.DEPLOY_TARGETS || '[]');
if (!Array.isArray(targets) || !targets.length) throw new Error('Configure the DEPLOY_TARGETS GitHub secret');
const body = process.env.DEPLOY_RELEASE;
if (!body) throw new Error('Missing DEPLOY_RELEASE');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function connectionError(error) {
  // Log transport codes, not request headers, secrets or server response bodies.
  const codes = new Set();
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.code === 'string' && /^[A-Z0-9_]+$/.test(value.code)) codes.add(value.code);
    if (value.cause) collect(value.cause);
    if (Array.isArray(value.errors)) value.errors.forEach(collect);
  }
  collect(error);
  const message = /^HTTP \d{3}$/.test(error?.message ?? '') ? error.message :
    error?.name === 'TimeoutError' ? 'request timed out' : 'connection or response failed';
  return `${message}${codes.size ? ` (${[...codes].join(', ')})` : ''}`;
}
async function request(target, route) {
  const timestamp = String(Date.now());
  const signature = 'sha256=' + createHmac('sha256', target.secret).update(`${timestamp}.${route}.`).update(body).digest('hex');
  const response = await fetch(new URL(route, target.url), {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-deploy-timestamp': timestamp, 'x-deploy-signature': signature },
    body, signal: AbortSignal.timeout(20_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
const results = await Promise.allSettled(targets.map(async (target, index) => {
  const url = new URL(target.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      typeof target.secret !== 'string' || target.secret.length < 32) throw new Error(`Invalid target ${index + 1}`);
  let result;
  for (let attempt = 0; attempt < 5; attempt++) {
    try { result = await request(target, '/deploy'); break; }
    catch (error) {
      const detail = connectionError(error);
      if (attempt === 4) throw new Error(`Machine ${index + 1}: notification failed: ${detail}`);
      console.warn(`Machine ${index + 1}: attempt ${attempt + 1} failed: ${detail}; retrying`);
      await sleep(10_000);
    }
  }
  const deadline = Date.now() + 25 * 60_000;
  while (result.status === 'deploying' && Date.now() < deadline) {
    await sleep(10_000);
    try { result = await request(target, '/status'); }
    catch { /* a temporary disconnection does not mean the deployment failed */ }
  }
  if (result.status !== 'succeeded') throw new Error(`Machine ${index + 1}: deployment ${result.status}${result.error ? `: ${result.error}` : ''}`);
  console.log(`Machine ${index + 1}: deployed successfully`);
}));
for (const result of results) if (result.status === 'rejected') console.error(result.reason.message);
if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
