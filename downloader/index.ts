import 'dotenv/config';
import fs from 'fs';
import readline from 'readline';
import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { PassThrough } from 'stream';
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
    Debug: true,
    Ws: true,
  });
  await client.init();
  const result: Generated = {
    previewImageUrl: '',
    upscaleImageUrls: [],
  };

  const message = await client.Imagine(
    prompt,
    (uri: string, progress: string) => {
      console.log("loading", uri, "progress", progress);
    }
  );
  if(!message) return null;
  result.previewImageUrl = message.uri;
  const indexs: number[] = [1,2,3,4];
  for(const i of indexs) {
    const upscale = await client.Upscale(
      message.content,
      i,
      <string>message.id,
      <string>message.hash,
      (uri: string, progress: string) => {
        console.log("loading", uri, "progress", progress);
      }
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
}

const s3 = new AWS.S3({
  region: <string>process.env.AWS_REGION,
  accessKeyId: <string>process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: <string>process.env.AWS_SECRET_ACCESS_KEY,
});

async function uploadUrl(key: string, url: string) {
  const stream = await axios.get(url, { responseType: 'stream' });
  const passThrough = new PassThrough();
  s3.upload({
    Key: key,
    Bucket: 'pipencil-content',
    CacheControl: 'max-age=31536000',
    ContentType: 'image/png',
    Body: passThrough,
  }, (error, data) => {
    if(error) {
      console.error(error);
      return
    }
    console.log('File upload successfully:', data.Location);
  });

  stream.data.pipe(passThrough);
}

const repeat = 2;

async function processLineByLine() {
  const stream = fs.createReadStream('./downloader/test.jsonl');
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    for(let i = 0; i < repeat; i++) {
      const request = JSON.parse(line) as Line;
      const result = await completion(request.prompt);
      if(!result) continue;
      // style_a/prompt_id_preview_{i}
      // style_a/prompt_id_upscale_{i}_0
      // style_a/prompt_id_upscale_{i}_1
      // style_a/prompt_id_upscale_{i}_2
      // style_a/prompt_id_upscale_{i}_3
      await uploadUrl(`${request.style}/${request.id}_preview_${i}`, result.previewImageUrl);
      for (const [j, url] of result.upscaleImageUrls.entries()) {
        await uploadUrl(`${request.style}/${request.id}_upscale_${i}_${j}`, url);
      }
    }
  }
}
