import { resolve } from 'node:path';
import { packagePreview } from './package_source_preview.mjs';
console.log(JSON.stringify(packagePreview(resolve(import.meta.dirname,'..'),process.argv[2],'runtime')));
