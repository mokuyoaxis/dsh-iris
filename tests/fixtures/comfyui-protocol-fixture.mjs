// Handwritten wire shapes from official server.py / nodes.py; no inference engine or node execution.
import http from 'node:http';
import { FLOW_RESULT } from './image-flow-fixture.mjs';

export const COMFY_WORKFLOW = { version: 1, promptNode: '6', outputNode: '9', sizeNode: '5', graph: {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
  '10': { class_type: 'LoraLoader', inputs: { model: ['4', 0], clip: ['4', 1], lora_name: 'iris.safetensors', strength_model: 1, strength_clip: 1 } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'Positive', clip: ['10', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'Negative', clip: ['10', 1] } },
  '3': { class_type: 'KSampler', inputs: { model: ['10', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
    seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1 } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'Iris' } }
}, parameters: [
  { id: 'lora', label: 'LoRA', node: '10', input: 'lora_name', type: 'string' },
  { id: 'model_weight', node: '10', input: 'strength_model', type: 'number', min: -2, max: 2 },
  { id: 'clip_weight', node: '10', input: 'strength_clip', type: 'number', min: -2, max: 2 },
  { id: 'negative', node: '7', input: 'text', type: 'string' },
  { id: 'seed', node: '3', input: 'seed', type: 'integer', min: 0 },
  { id: 'steps', node: '3', input: 'steps', type: 'integer', min: 1, max: 100 },
  { id: 'sampler', node: '3', input: 'sampler_name', type: 'string', choices: ['euler', 'dpmpp_2m'] }
] };
const definition = (required, output, output_node = false) => ({ input: { required }, output, output_node });
export const COMFY_SCHEMAS = {
  CheckpointLoaderSimple: definition({ ckpt_name: [['base.safetensors']] }, ['MODEL', 'CLIP', 'VAE']),
  LoraLoader: definition({ model: ['MODEL'], clip: ['CLIP'], lora_name: [['iris.safetensors', 'portrait.safetensors']],
    strength_model: ['FLOAT', { min: -100, max: 100 }], strength_clip: ['FLOAT', { min: -100, max: 100 }] }, ['MODEL', 'CLIP']),
  EmptyLatentImage: definition({ width: ['INT', { min: 16, max: 16384 }], height: ['INT', { min: 16, max: 16384 }], batch_size: ['INT', { min: 1, max: 4096 }] }, ['LATENT']),
  CLIPTextEncode: definition({ text: ['STRING', { multiline: true }], clip: ['CLIP'] }, ['CONDITIONING']),
  KSampler: definition({ model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'],
    seed: ['INT', { min: 0, max: 18446744073709551615 }], steps: ['INT', { min: 1, max: 10000 }], cfg: ['FLOAT', { min: 0, max: 100 }],
    sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'karras']], denoise: ['FLOAT', { min: 0, max: 1 }] }, ['LATENT']),
  VAEDecode: definition({ samples: ['LATENT'], vae: ['VAE'] }, ['IMAGE']),
  SaveImage: definition({ images: ['IMAGE'], filename_prefix: ['STRING'] }, ['IMAGE'], true)
};
export async function comfyProtocolFixture() {
  const requests = [], graphs = [], schemas = structuredClone(COMFY_SCHEMAS);
  let mode = 'normal', phase = 'queued';
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, 'http://fixture');
    requests.push({ path: req.url, method: req.method, authorization: req.headers.authorization });
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/system_stats') return send({ system: { os: 'fixture' } });
    if (url.pathname.startsWith('/object_info/')) {
      if (mode === 'drop') { req.socket.destroy(); return; }
      if (mode === 'malformed') { res.end('{'); return; }
      if (mode === 'unauthorized') return send({ error: 'private fixture upstream detail' }, 401);
      if (mode === 'oversized') { res.writeHead(200, { 'Content-Length': 3 * 1024 * 1024 }); res.end(); return; }
      if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:1/credential-trap' }); res.end(); return; }
      if (mode === 'hang') return;
      const type = decodeURIComponent(url.pathname.slice('/object_info/'.length));
      return send(schemas[type] ? { [type]: schemas[type] } : {});
    }
    if (url.pathname === '/prompt' && req.method === 'POST') {
      graphs.push(JSON.parse(Buffer.concat(chunks)).prompt);
      if (mode === 'post-lost') { req.socket.destroy(); return; }
      return send({ prompt_id: 'prompt_' + graphs.length, number: graphs.length, node_errors: {} });
    }
    if (url.pathname === '/queue') return send({ queue_running: [], queue_pending: phase === 'queued' ? graphs.map((_, index) => [index, 'prompt_' + (index + 1), {}, {}]) : [] });
    if (url.pathname.startsWith('/history/')) {
      const id = url.pathname.slice('/history/'.length);
      return send(phase !== 'done' ? {} : { [id]: { status: { completed: true, status_str: 'success', messages: [] },
        outputs: { '9': { images: [{ filename: 'result.png', subfolder: 'Iris', type: 'output' }] } } } });
    }
    if (url.pathname === '/view') { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(FLOW_RESULT); return; }
    send({}, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: 'http://127.0.0.1:' + server.address().port, requests, graphs, schemas,
    set mode(value) { mode = value; }, set phase(value) { phase = value; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
