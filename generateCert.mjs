import { generateKeyPairSync, createSign } from 'crypto';
import fs from 'fs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

fs.writeFileSync('key.pem', privateKeyPem);

console.log('key.pem generated!');
console.log('Now run: node server.mjs');