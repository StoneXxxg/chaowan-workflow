const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'data', 'popmart-catalog.json');

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 12 * 1024 * 1024) throw new Error('request_too_large');
  }
  return raw ? JSON.parse(raw) : {};
}

async function catalog() {
  return JSON.parse(await fs.readFile(CATALOG_PATH, 'utf8'));
}

function missing(name) {
  return json({ writeHead() {} });
}

async function ocr(req, res) {
  if (!process.env.OPENAI_API_KEY) {
    return json(res, 503, { error: 'ocr_not_configured', message: '需要配置 OPENAI_API_KEY 才能执行真实截图 OCR。未返回伪造结果。' });
  }
  const input = await body(req);
  if (!input.image_base64 || typeof input.image_base64 !== 'string') {
    return json(res, 400, { error: 'image_base64_required' });
  }
  const mime = input.mime_type || 'image/png';
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || 'gpt-4.1-mini',
      input: [{ role: 'user', content: [
        { type: 'input_text', text: '从这张盲盒截图中识别可见文字。只返回严格 JSON：{"ip":string|null,"series":string|null,"style":string|null,"confidence":number,"evidence":string[]}。无法确认的字段必须为 null，不要猜测。' },
        { type: 'input_image', image_url: `data:${mime};base64,${input.image_base64}` }
      ] }],
      text: { format: { type: 'json_object' } }
    })
  });
  const data = await response.json();
  if (!response.ok) return json(res, response.status, { error: 'ocr_provider_error', provider: data });
  const text = data.output?.flatMap(x => x.content || []).find(x => x.type === 'output_text')?.text;
  if (!text) return json(res, 502, { error: 'ocr_empty_result' });
  return json(res, 200, { source: 'openai_vision', result: JSON.parse(text) });
}

async function search(req, res) {
  const input = await body(req);
  if (!input.ip || !input.series) return json(res, 400, { error: 'ip_and_series_required' });
  const cacheDir = process.env.CHAOWAN_CACHE_DIR || path.join(ROOT, '.chaowan-cache');
  const key = crypto.createHash('sha256').update(JSON.stringify([input.ip.trim(), input.series.trim()])).digest('hex');
  const cachePath = path.join(cacheDir, `${key}.json`);
  if (!input.refresh) {
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      if (Date.now() - cached.savedAt < 7 * 24 * 60 * 60 * 1000) return json(res, 200, { ...cached.data, cached: true });
    } catch (_) { /* Missing or invalid cache: search normally. */ }
  }
  if (!process.env.TAVILY_API_KEY) {
    return json(res, 503, { error: 'search_not_configured', message: '需要配置 TAVILY_API_KEY 才能执行真实网页搜索。未返回演示结果。' });
  }
  const query = `${input.ip} ${input.series} 盲盒 手感 热款 隐藏款 中文 玩家经验`;
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.TAVILY_API_KEY, query, search_depth: 'advanced', max_results: Number(input.max_results || 10), include_answer: false })
  });
  const data = await response.json();
  if (!response.ok) return json(res, response.status, { error: 'search_provider_error', provider: data });
  const results = (data.results || []).map(x => ({ title: x.title, url: x.url, content: x.content, score: x.score }));
  if (!process.env.OPENAI_API_KEY) return json(res, 503, { error: 'summary_not_configured', message: '搜索完成，但未配置总结服务。', results });
  if (!results.length) return json(res, 200, { query, results, summary: '没有找到相关资料，无法总结手感。' });
  const summaryResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini', input: `请用中文根据以下搜索摘要整理盲盒手感，分款列出重量、晃动、声音、配件、隐藏款。只能使用资料中明确支持的信息，不足之处写“未找到可靠资料”，不可猜测。注明来源编号，提醒手感不能保证结果。\nIP：${input.ip}\n系列：${input.series}\n${results.map((x, i) => `[${i + 1}] ${x.title}\n${x.content}`).join('\n')}` })
  });
  const summaryData = await summaryResponse.json();
  if (!summaryResponse.ok) return json(res, 502, { error: 'summary_provider_error', message: `总结服务请求失败（${summaryResponse.status}）：${summaryData.error?.message || '请检查服务配置'}`, results });
  const summary = summaryData.output?.flatMap(x => x.content || []).find(x => x.type === 'output_text')?.text;
  if (!summary) return json(res, 502, { error: 'summary_empty', message: '总结服务没有返回正文。', results });
  const result = { query, source: 'tavily', results, summary, cached: false };
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify({ savedAt: Date.now(), data: result }));
  } catch (_) { /* A cache failure must not hide successful research. */ }
  return json(res, 200, result);
}

async function handler(req, res) {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const page = await fs.readFile(path.join(ROOT, 'dist', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true, configured: { ocr: Boolean(process.env.OPENAI_API_KEY), search: Boolean(process.env.TAVILY_API_KEY) } });
    if (req.method === 'GET' && req.url === '/api/catalog') return json(res, 200, await catalog());
    if (req.method === 'POST' && req.url === '/api/ocr') return await ocr(req, res);
    if (req.method === 'POST' && req.url === '/api/search') return await search(req, res);
    return json(res, 404, { error: 'not_found' });
  } catch (e) { return json(res, 400, { error: e.message || 'bad_request' }); }
}

http.createServer(handler).listen(PORT, () => console.log(`blind-box backend listening on http://localhost:${PORT}`));
