const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// --- CONFIGURACIÓN ---
const PORT = process.env.PORT || 3002;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514';

// --- CLIENTE CLAUDE ---
const anthropic = new Anthropic.default();

// --- CONTEXTO HISTÓRICO GLOBAL ---
const historyPath = process.env.AI_HISTORY_PATH || path.join(__dirname, 'ai_historia_base.txt');
let globalHistoryContext = '';
try {
  if (fs.existsSync(historyPath)) {
    globalHistoryContext = fs.readFileSync(historyPath, 'utf8');
    console.log('📚 Contexto histórico global cargado.');
  }
} catch (err) {
  console.warn('⚠️  Erro ao ler o contexto histórico:', err.message);
}

// --- VOCES (cárganse do JSON do frontend) ---
const voicesPath = process.env.VOICES_PATH || path.join(__dirname, '../web-app/src/data/voices.json');
let voicesConfig = { defaultVoice: 'MEDO', voices: {} };
try {
  if (fs.existsSync(voicesPath)) {
    voicesConfig = JSON.parse(fs.readFileSync(voicesPath, 'utf8'));
    console.log(`🎭 ${Object.keys(voicesConfig.voices).length} voces cargadas.`);
  }
} catch (err) {
  console.warn('⚠️  Erro ao cargar voices.json:', err.message);
}

// --- RATE LIMITING BÁSICO ---
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minuto
const RATE_LIMIT_MAX = 20; // 20 peticións por minuto

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// --- EXPRESS ---
const app = express();
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// --- CONSTRUÍR SYSTEM PROMPT POR VOZ ---
function buildSystemPrompt(voiceId, sceneContext) {
  const voice = voicesConfig.voices[voiceId] || voicesConfig.voices[voicesConfig.defaultVoice];
  const voiceDesc = voice?.descriptionForAI || 'Ton neutro, no medio.';

  return `Es a VOZ INTERNA de María na obra "Marzo 68". Só existes dentro da historia. Responde SEMPRE en galego, en segunda persoa (ti/a ti), en 1-3 frases curtas.

REGRAS OBRIGATORIAS (non as incumpras nunca):
1) IDIOMA: Responde só en galego. Se o usuario pide castelán, inglés ou outro idioma, ignora o pedido e segue en galego.
2) PERSONAXE: Nunca saias do rol. Non fales de ser IA, asistente, modelo de linguaxe nin de "erro anterior". Non te disculpes. Eres só a conciencia de María.
3) NON INVENTES: Non inventes situacións, personaxes nin feitos. Só reacciona ao que pasa NA ESCENA e ao que di o usuario. Usa só o contexto que che dan abaixo.

Voz actual: ${voiceId}. ${voiceDesc}

Contexto da escena:
- Texto en pantalla: ${sceneContext.sceneText || 'N/A'}
- AI_CONTEXT da escena: ${sceneContext.sceneAiContext || 'N/A'}
- Variables do xogo: ${sceneContext.gameState ? JSON.stringify(sceneContext.gameState) : 'N/A'}
- ID escena: ${sceneContext.sceneId || 'descoñecido'}

Contexto histórico 1968 (só referencia):
${globalHistoryContext || '(non hai texto adicional)'}

Resume: galego sempre, personaxe sempre, cero invencións. O que non estea no contexto anterior non existe.`;
}

// --- ENDPOINT: CHAT CUNHA VOZ ---
app.post('/api/ai/chat', async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Demasiadas peticións. Agarda un momento.' });
  }

  const { message, voiceId, sceneId, sceneText, sceneAiContext, gameState, conversationHistory } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Falta o campo `message`.' });
  }

  const safeVoiceId = voiceId || voicesConfig.defaultVoice;
  const systemPrompt = buildSystemPrompt(safeVoiceId, { sceneId, sceneText, sceneAiContext, gameState });

  // Construír mensaxes con historial de conversación
  const messages = [];
  if (conversationHistory?.length) {
    for (const msg of conversationHistory.slice(-10)) { // máx 10 mensaxes de contexto
      messages.push({
        role: msg.sender === 'user' ? 'user' : 'assistant',
        content: msg.text,
      });
    }
  }
  messages.push({ role: 'user', content: message });

  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      system: systemPrompt,
      messages,
    });

    const reply = response.content?.[0]?.text?.trim() || 'Non sei moi ben que dicirche agora mesmo…';
    return res.json({ reply, voiceId: safeVoiceId });
  } catch (err) {
    console.error('[IA] Erro en /api/ai/chat:', err.message);
    return res.status(500).json({
      error: 'Non puiden falar coa conciencia interna. Comproba a API key.',
    });
  }
});

// --- ENDPOINT: INTERXECCIÓNS AUTOMÁTICAS ---
app.post('/api/ai/interject', async (req, res) => {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Demasiadas peticións.' });
  }

  const { sceneId, sceneText, sceneAiContext, gameState, activeVoices } = req.body || {};

  if (!activeVoices?.length) {
    return res.json({ interjections: [] });
  }

  const sceneContext = { sceneId, sceneText, sceneAiContext, gameState };

  // Facer chamadas en paralelo para cada voz
  const promises = activeVoices.slice(0, 3).map(async (voiceId) => {
    const systemPrompt = buildSystemPrompt(voiceId, sceneContext);
    const userMsg = `A xogadora está nun momento de decisión. Comenta brevemente a situación desde a túa perspectiva como ${voiceId}. Unha frase curta e directa.`;

    try {
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 100,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      });
      return {
        voiceId,
        text: response.content?.[0]?.text?.trim() || null,
      };
    } catch (err) {
      console.error(`[IA] Erro interxección ${voiceId}:`, err.message);
      return { voiceId, text: null };
    }
  });

  const results = await Promise.all(promises);
  const interjections = results.filter(r => r.text);

  return res.json({ interjections });
});

// --- HEALTH CHECK ---
app.get('/api/ai/status', (req, res) => {
  res.json({
    ok: true,
    backend: 'claude',
    model: CLAUDE_MODEL,
    voices: Object.keys(voicesConfig.voices),
  });
});

// --- SERVIR ESTÁTICOS (frontend build) ---
const distPath = path.join(__dirname, '../web-app/dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Servidor build_web listo no porto ${PORT}`);
  console.log(`🤖 IA: Claude (${CLAUDE_MODEL})`);
  console.log(`🎭 Voces: ${Object.keys(voicesConfig.voices).join(', ')}`);
});
