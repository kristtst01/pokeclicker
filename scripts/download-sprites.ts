import fetch from 'node-fetch';
import {createWriteStream} from 'fs';
import {mkdir} from 'fs/promises';
import {pipeline} from 'stream/promises';
import {join, dirname} from 'path';
import {fileURLToPath} from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TOTAL_POKEMON = 1025;
const BATCH_SIZE = 50;
const SPRITE_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
const OUTPUT_DIR = join(__dirname, '../frontend/public/sprites');

async function downloadSprite(id: number): Promise<boolean> {
  const url = `${SPRITE_BASE_URL}/${id}.png`;
  const outputPath = join(OUTPUT_DIR, `${id}.png`);

  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) return false;

    await pipeline(response.body, createWriteStream(outputPath));
    return true;
  } catch (error) {
    console.error(`Failed to download #${id}`);
    return false;
  }
}

async function main() {
  console.log(`Downloading ${TOTAL_POKEMON} sprites to ${OUTPUT_DIR}`);

  await mkdir(OUTPUT_DIR, {recursive: true});

  let success = 0;
  let failed = 0;

  for (let i = 1; i <= TOTAL_POKEMON; i += BATCH_SIZE) {
    const end = Math.min(i + BATCH_SIZE - 1, TOTAL_POKEMON);

    const promises = [];
    for (let id = i; id <= end; id++) {
      promises.push(downloadSprite(id));
    }

    const results = await Promise.all(promises);
    success += results.filter(r => r).length;
    failed += results.filter(r => !r).length;

    console.log(`Downloaded ${i}-${end} (${success}/${i + results.length - 1})`);

    if (end < TOTAL_POKEMON) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log(`\nDone: ${success} succeeded, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(console.error);
