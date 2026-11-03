# 潮玩盲盒后端接口骨架

独立于 `dist/`，当前不会修改主页面。

## 接口

- `GET /api/health`：查看密钥是否配置。
- `GET /api/catalog`：读取现有官方目录 JSON。
- `POST /api/ocr`：JSON `{ "image_base64": "...", "mime_type": "image/png" }`，调用 OpenAI Vision；未配置密钥时返回 503，不伪造结果。
- `POST /api/search`：JSON `{ "ip": "Hirono", "series": "...", "max_results": 10 }`，调用 Tavily；未配置密钥时返回 503，不伪造结果。

需要运行时密钥：`OPENAI_API_KEY`、`TAVILY_API_KEY`。密钥只通过环境变量注入，不写入仓库。

启动：

```bash
cd backend
OPENAI_API_KEY=... TAVILY_API_KEY=... npm start
```
