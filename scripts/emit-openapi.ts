import { writeFileSync } from 'node:fs';
import { buildApp } from '../src/openapi.js';

const app = buildApp();
const res = await app.request('/openapi.json');
const body = await res.text();
writeFileSync('openapi.json', body);
console.log(`[emit-openapi] wrote openapi.json (${body.length} bytes)`);
