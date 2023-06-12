import 'dotenv/config';
import fs from 'fs';
import readline from 'readline';
import { Midjourney } from "../src";
import { uploadUrl } from './s3';

interface Generated {
  previewImageUrl: string;
  upscaleImageUrls: string[];
}

async function completion(client: Midjourney, prompt: string): Promise<Generated | null> {
  const result: Generated = { previewImageUrl: '', upscaleImageUrls: [] };
  const loadingHandler = (_: string, progress: string) => console.log("Loading progress:", progress);
  const message = await client.Imagine(prompt, loadingHandler);
  if(!message) return null;
  result.previewImageUrl = message.uri;
  const indexs: number[] = [1,2,3,4];
  for(const i of indexs) {
    const upscale = await client.Upscale(
      message.content,
      i,
      <string>message.id,
      <string>message.hash,
      loadingHandler
    );
    if(upscale) {
      result.upscaleImageUrls.push(upscale.uri);
    }
  }
  return result;
}

interface Line {
  id: string;
  style: string;
  prompt: string;
  seed: number;
}

const repeat = 1;
const startLine = 0;
const concurrency = 2;

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// style_a/prompt_id_preview_{i}
// style_a/prompt_id_upscale_{i}_0
// style_a/prompt_id_upscale_{i}_1
// style_a/prompt_id_upscale_{i}_2
// style_a/prompt_id_upscale_{i}_3
async function processLine(client: Midjourney, line: string, order: number) {
  await delay(order * 1000 + Math.floor(Math.random() * 2000));
  const request = JSON.parse(line) as Line;
  for(let i = 0; i < repeat; i++) {
    const result = await completion(client, `${request.prompt} --seed ${request.seed}`);
    if(!result) continue;
    await uploadUrl(`${request.style}/${request.id}_preview_${i}`, result.previewImageUrl);
    for (const [j, url] of result.upscaleImageUrls.entries()) {
      await uploadUrl(`${request.style}/${request.id}_upscale_${i}_${j}`, url);
    }
  }
}

async function processJSONL(path: string) {
  const client = new Midjourney({
    ServerId: <string>process.env.SERVER_ID,
    ChannelId: <string>process.env.CHANNEL_ID,
    SalaiToken: <string>process.env.SALAI_TOKEN,
    HuggingFaceToken: <string>process.env.HUGGINGFACE_TOKEN,
    Debug: false,
    Ws: true,
    MaxWait: 200,
  });
  await client.init();

  const stream = fs.createReadStream(path);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  let tasks: Promise<void>[] = [];
  try {
    for await (const line of rl) {
      lineCount++;
      if (lineCount < startLine) continue; // skip line
      if(tasks.length <= concurrency) {
        tasks.push(processLine(client, line, tasks.length));
      }
      if (tasks.length === concurrency) {
        console.log(`Line: ${lineCount - concurrency} ----------------------------------------------------------------------`);
        await Promise.all(tasks);
        tasks = [];
      }
    }
  } catch(e) {
    console.log('stop at line:', lineCount);
    console.error('process failed:', e);
  }
}

processJSONL('./downloader/prompts_with_seed_v2.jsonl').then(() => console.log('Done!'));
