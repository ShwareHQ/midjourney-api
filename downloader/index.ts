import 'dotenv/config';
import fs from 'fs';
import axios from 'axios';
import readline from 'readline';
import { PassThrough } from 'stream';
import { Upload } from "@aws-sdk/lib-storage";
import { S3Client } from "@aws-sdk/client-s3";
import { Midjourney } from "../src";

interface Generated {
  previewImageUrl: string;
  upscaleImageUrls: string[];
}

async function completion(prompt: string): Promise<Generated | null> {
  const client = new Midjourney({
    ServerId: <string>process.env.SERVER_ID,
    ChannelId: <string>process.env.CHANNEL_ID,
    SalaiToken: <string>process.env.SALAI_TOKEN,
    HuggingFaceToken: <string>process.env.HUGGINGFACE_TOKEN,
    Debug: false,
    Ws: true,
  });
  await client.init();
  const result: Generated = {
    previewImageUrl: '',
    upscaleImageUrls: [],
  };

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

const client = new S3Client({ region: <string>process.env.AWS_REGION });

async function uploadUrl(key: string, url: string) {
  const stream = await axios.get(url, { responseType: 'stream' });
  const passThrough = new PassThrough();
  const upload = new Upload({
    client,
    params: {
      Key: `midjourney/${key}`,
      Bucket: 'pipencil-content',
      CacheControl: 'max-age=31536000',
      ContentType: 'image/png',
      Body: passThrough,
    },
    queueSize: 4, // optional concurrency configuration
    partSize: 1024 * 1024 * 5, // optional size of each part, in bytes, at least 5MB
    leavePartsOnError: false, // optional manually handle dropped parts
  });

  upload.on('httpUploadProgress', (progress) => {
    console.log(`Uploading ${key} part: ${progress.part}`);
  });

  stream.data.pipe(passThrough);
  await upload.done();
}

const repeat = 1;
const startLine = 0;
const concurrency = 12;

// style_a/prompt_id_preview_{i}
// style_a/prompt_id_upscale_{i}_0
// style_a/prompt_id_upscale_{i}_1
// style_a/prompt_id_upscale_{i}_2
// style_a/prompt_id_upscale_{i}_3
async function processLine(line: string) {
  const request = JSON.parse(line) as Line;
  for(let i = 0; i < repeat; i++) {
    const result = await completion(`${request.prompt} --seed ${request.seed}`);
    if(!result) continue;
    await uploadUrl(`${request.style}/${request.id}_preview_${i}`, result.previewImageUrl);
    for (const [j, url] of result.upscaleImageUrls.entries()) {
      await uploadUrl(`${request.style}/${request.id}_upscale_${i}_${j}`, url);
    }
  }
}

async function processJSONL(path: string) {
  const stream = fs.createReadStream(path);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  let tasks: Promise<void>[] = [];
  try {
    for await (const line of rl) {
      lineCount++;
      if (lineCount < startLine) continue;      
      if(tasks.length < concurrency) {
        tasks.push(processLine(line));
      } else {
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
