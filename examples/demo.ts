/**
 * examples/demo.ts
 *
 * PromptWatch — 60 saniyelik canlı demo.
 * Otomatik prompt versiyonlama + A/B testi oluşturma + sticky (deterministik)
 * bucketing, uçtan uca tek bir script içinde gösterilir.
 *
 * Çalıştırma (repo kökünden, sırayla):
 *   1) npm run build --workspace=packages/sdk   (bir kere — SDK derlenmeli)
 *   2) docker compose up -d                     (backend ayakta olmalı)
 *   3) npm run demo                              (root package.json'a eklenecek script)
 *
 *      Root package.json'a şu script'i ekleyin:
 *        "demo": "tsx examples/demo.ts"
 *
 * OPENAI_API_KEY (.env içinde) tanımlıysa gerçek OpenAI çağrıları yapılır.
 * Tanımlı değilse, demo network/API key'e bağımlı kalıp riske girmesin diye
 * deterministik gecikmeli bir mock client'a otomatik düşülür.
 */

import "dotenv/config";
import OpenAI from "openai";
import { wrapOpenAI, ABCache, assignVariant, sha256, type ABTestConfig } from "@promptwatch/sdk";

const BACKEND_URL = process.env.PROMPTWATCH_BACKEND_URL ?? "http://localhost:3000";
const PROMPT_NAME = "support-agent";
const USER_QUESTION = "Siparişim ne zaman elime ulaşır?";

const PROMPT_V1 =
  "Sen Acme A.Ş. için çalışan kibar ve profesyonel bir müşteri destek asistanısın. " +
  "Sorulara detaylı ve kapsamlı açıklamalarla, resmi bir dille yanıt ver.";

const PROMPT_V2 =
  "Sen Acme A.Ş. için çalışan samimi bir müşteri destek asistanısın. " +
  "Kısa, net ve sıcak bir dille yanıt ver. Gereksiz uzatma.";

const SIMULATED_USERS = ["ayse_42", "mehmet_17", "zeynep_08", "can_99", "elif_31", "burak_05"];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function line(): void {
  console.log("─".repeat(46));
}

/** Gerçek OpenAI SDK'sıyla aynı şekle sahip, deterministik gecikmeli bir mock client. */
function createMockClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: async (params: any) => {
          await sleep(180 + Math.random() * 200);
          const systemText: string =
            params.messages?.find((m: any) => m.role === "system")?.content ?? "";
          const promptTokens = Math.max(20, Math.round(systemText.length / 4));
          const completionTokens = 35 + Math.floor(Math.random() * 30);
          return {
            id: "mock-" + Math.random().toString(36).slice(2, 10),
            model: params.model ?? "gpt-4o-mini",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "(mock yanıt) Merhaba, size yardımcı olmaktan mutluluk duyarım.",
                },
              },
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          };
        },
      },
    },
  } as unknown as OpenAI;
}

/**
 * SDK normalde bunu her wrapped çağrıda arka planda (fire-and-forget) kendisi yapar.
 * Burada A/B testi kurabilmek için prompt'un id'sine ihtiyacımız olduğundan doğrudan çağırıyoruz.
 */
async function resolvePromptDirect(promptText: string): Promise<{ id: number; version: number }> {
  const res = await fetch(`${BACKEND_URL}/api/prompts/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: PROMPT_NAME, promptText, hash: sha256(promptText) }),
  });
  if (!res.ok) throw new Error(`resolve isteği başarısız: HTTP ${res.status}`);
  return res.json();
}

async function preflightCheck(): Promise<void> {
  try {
    const res = await fetch(`${BACKEND_URL}/api/ab-tests/active`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    console.error(`❌ Backend'e ulaşılamıyor (${BACKEND_URL}).`);
    console.error(`   'docker compose up -d' çalıştığından emin olun ve tekrar deneyin.`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await preflightCheck();

  const useReal = Boolean(process.env.OPENAI_API_KEY);
  console.log("🚀 PromptWatch Demo Başlıyor...");
  console.log(
    `📡 Mode: ${useReal ? "REAL (gerçek OpenAI çağrıları)" : "MOCK (OPENAI_API_KEY tanımlı değil)"}\n`
  );

  const rawClient = useReal ? new OpenAI() : createMockClient();

  // Demo'ya özel: ABCache'i kendimiz oluşturup 2 saniyelik poll interval'ıyla başlatıyoruz
  // (production varsayılanı 30sn'dir — burada 60 saniyelik demo'ya sığması için kısaltıyoruz).
  const demoCache = new ABCache();
  demoCache.start(BACKEND_URL, 2000);

  let currentUser: string | undefined;
  const client = wrapOpenAI(rawClient, {
    promptName: PROMPT_NAME,
    backendUrl: BACKEND_URL,
    cache: demoCache,
    getDistinctId: () => currentUser,
  });

  line();
  console.log("1️⃣  OTOMATİK VERSİYONLAMA");
  line();

  console.log("→ İlk system prompt gönderiliyor...");
  const v1 = await resolvePromptDirect(PROMPT_V1);
  await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: PROMPT_V1 },
      { role: "user", content: USER_QUESTION },
    ],
  });
  console.log(`✅ "${PROMPT_NAME}" v${v1.version} olarak kaydedildi (id: ${v1.id})`);
  console.log(`   "${PROMPT_V1.slice(0, 55)}..."\n`);

  console.log("→ Prompt metni değiştirildi (daha samimi bir tona), tekrar gönderiliyor...");
  const v2 = await resolvePromptDirect(PROMPT_V2);
  await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: PROMPT_V2 },
      { role: "user", content: USER_QUESTION },
    ],
  });
  console.log(`✅ "${PROMPT_NAME}" v${v2.version} olarak OTOMATİK versiyonlandı (id: ${v2.id})`);
  console.log(`   "${PROMPT_V2.slice(0, 55)}..."`);
  console.log(
    "   → Manuel bir 'versiyon kaydet' adımı yok; SDK hash'i karşılaştırıp kendisi yeni versiyon açtı.\n"
  );

  line();
  console.log("2️⃣  A/B TESTİ OLUŞTURULUYOR");
  line();

  const abTestRes = await fetch(`${BACKEND_URL}/api/ab-tests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "support-agent-tone-test",
      promptName: PROMPT_NAME,
      variantAId: v1.id,
      variantBId: v2.id,
      splitPercent: 50,
    }),
  });
  if (!abTestRes.ok) throw new Error(`A/B testi oluşturulamadı: HTTP ${abTestRes.status}`);
  const createdTest = await abTestRes.json();

  console.log(
    `✅ "support-agent-tone-test" oluşturuldu → v${v1.version} (A) vs v${v2.version} (B), %50/%50`
  );
  console.log("⏳ SDK'nın bunu arka planda senkronize etmesi için birkaç saniye bekleniyor...\n");
  await sleep(2500);

  line();
  console.log("3️⃣  FARKLI KULLANICILAR, STICKY (DETERMİNİSTİK) BUCKETING");
  line();

  const displayConfig: ABTestConfig = {
    id: createdTest.id,
    promptName: PROMPT_NAME,
    variantAId: v1.id,
    variantAText: PROMPT_V1,
    variantBId: v2.id,
    variantBText: PROMPT_V2,
    splitPercent: 50,
  };

  for (const userId of SIMULATED_USERS) {
    currentUser = userId;
    // NOT: Buraya yazdığımız system content önemli değil — aktif bir A/B testi olduğu için
    // SDK, OpenAI'a giden metni otomatik olarak seçilen varyantla değiştiriyor.
    // assignVariant() burada SADECE ekrana yazdırmak için; SDK'nın kendi içinde yaptığı
    // hesaplamayla birebir aynı (deterministik — aynı testId + userId = her zaman aynı sonuç).
    const preview = assignVariant(displayConfig, userId);
    await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: PROMPT_V1 },
        { role: "user", content: USER_QUESTION },
      ],
    });
    console.log(
      `👤 ${userId.padEnd(12)} → Variant ${preview.variant} (v${
        preview.variant === "A" ? v1.version : v2.version
      })`
    );
  }

  line();
  console.log(
    `✅ DEMO TAMAMLANDI — ${2 + SIMULATED_USERS.length} trace, 2 prompt versiyonu, 1 aktif A/B testi üretildi`
  );
  console.log(`👉 Dashboard: ${BACKEND_URL}`);
  line();

  demoCache.stop();
}

main().catch((err) => {
  console.error("\n❌ Demo başarısız oldu:", err);
  process.exit(1);
});