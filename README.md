# PromptWatch

Prompt'ları izlemek, A/B test edip maliyet / hata oranı metrikleri toplamak için hafif bir araç.
OpenAI çağrılarını saran bir **SDK**, prompt versiyonlarını, A/B testlerini ve traces'ı saklayan bir
**Backend (Next.js + Prisma + Postgres)** ve bu metrikleri görselleştiren bir **Dashboard**'dan oluşur.

## Mimari: SDK → Backend → Dashboard

1. **SDK** (`packages/sdk`): `chat.completions.create`'i sarar. System prompt'un SHA-256'sını hesaplar ve
   `POST /api/prompts/resolve` ile prompt versiyonunu çözer (paralel başlatılır, OpenAI çağrısı gecikmez).
   Trace, `POST /api/traces` ile fire-and-forget gönderilir. Aktif bir A/B testi varsa system prompt
   varyant metniyle değiştirilir ve trace `abTestId`/`variant` ile işaretlenir.
2. **Backend** (`apps/web`): `prompts`, `ab_tests`, `traces` tablolarını tutar; resolve, traces, ab-tests
   ve metrik endpoint'lerini sunar.
3. **Dashboard**: `/` günlük maliyet ve hata oranı grafikleri, `/ab-tests` A/B karşılaştırma ve test oluşturma.

## Kurulum

```bash
cp .env.example .env   # OPENAI_API_KEY'i doldur
docker compose up -d --build
```

Migration ve seed (istendiğinde):

```bash
docker compose exec web npx prisma migrate deploy
docker compose exec web npx prisma db seed
```

Dashboard: http://localhost:3000

## SDK Kullanımı

```ts
import OpenAI from "openai";
import { wrapOpenAI } from "@promptwatch/sdk";

const client = wrapOpenAI(new OpenAI({ apiKey: process.env.OPENAI_API_KEY! }), {
  promptName: "support-bot",
  backendUrl: process.env.PROMPTWATCH_BACKEND_URL ?? "http://localhost:3000",
  getDistinctId: () => currentUserIdFromRequestContext(), // A/B bucketing için her çağrıda taze
});
```

### Serverless / Edge NOT

Telemetry fire-and-forget gönderilir; serverless ortamda process istekten sonra dondurulabileceği için
yanıt dönülmeden önce pending traces'ları boşalt:

```ts
import { TelemetryClient } from "@promptwatch/sdk";

const telemetry = new TelemetryClient(BACKEND_URL);
wrapOpenAI(openai, { promptName, backendUrl: BACKEND_URL, telemetry });

// handler sonunda:
await telemetry.flush();
```

ya da platformun `waitUntil` API'sini kullanın.

## Örnek

`examples/basic-node-app` — gerçek OpenAI çağrısı yapan minimal script:

```bash
OPENAI_API_KEY'ini .env'e doldur
npm run start --workspace=examples/basic-node-app
```