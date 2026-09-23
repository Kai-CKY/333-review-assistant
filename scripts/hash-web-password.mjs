import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '../apps/api/src/web-auth.js';

// Hidden interactive input keeps plaintext out of shell history and process arguments.
if (!process.stdin.isTTY) throw new Error('Run this command in an interactive terminal.');
const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
const input = createInterface({ input: process.stdin, output, terminal: true });
input.on('SIGINT', () => { input.close(); process.exit(130); });
process.stdout.write('Password (hidden): ');
const password = await new Promise(resolve => input.question('', resolve));
input.close();
process.stdout.write('\n');
if (password.length < 12 || password.length > 1024) throw new Error('Use a password of 12..1024 characters.');
console.log(await hashPassword(password));
