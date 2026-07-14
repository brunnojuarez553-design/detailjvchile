// /api/inspeccion.js
// Endpoint que recibe las fotos del formulario "Inspección digital" y las manda
// a Groq (modelo con visión) para generar un reporte preliminar del estado de la pintura.
//
// Requiere la variable de entorno GROQ_API_KEY_INSPECCION configurada en Vercel
// (Project Settings → Environment Variables). Nunca expongas esta key en el frontend.
//
// Modelo: qwen/qwen3.6-27b (modelo de visión vigente en Groq a jul-2026).
// OJO: es un modelo de RAZONAMIENTO — por defecto piensa antes de responder y mezcla
// tokens de "pensamiento" en el content, lo que rompe el JSON.parse de una respuesta
// en json_object mode. Por eso reasoning_effort:'none' es obligatorio acá: sin esto,
// las respuestas fallan de forma intermitente/total y además tardan mucho más
// (riesgo de timeout de la función serverless).
//
// Límite de Groq para imágenes en base64: 4MB por request y máximo 5 imágenes.
// El frontend (site213.html) ya redimensiona/comprime las fotos antes de mandarlas —
// si se edita ese código, no sacar esa parte o va a tirar error 413.
//
// Si en el futuro este endpoint vuelve a fallar, revisar
// https://console.groq.com/docs/deprecations por si hay que migrar el modelo de nuevo.

export const config = {
  maxDuration: 30, // seg. Da margen de sobra incluso si Groq tarda más de lo normal.
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'qwen/qwen3.6-27b';
const MAX_IMAGES = 4;
const FETCH_TIMEOUT_MS = 25_000;

const SYSTEM_PROMPT =
  'Sos un experto en detailing automotriz. Analizá estas fotos de un vehículo y ' +
  'generá un reporte PRELIMINAR (no es un diagnóstico definitivo, aclaralo si corresponde) ' +
  'del estado de la pintura. Respondé EXCLUSIVAMENTE con un objeto JSON, sin texto adicional, ' +
  'sin explicaciones, sin markdown, con esta forma exacta:\n' +
  '{\n' +
  '  "estado_pintura": "texto breve describiendo el estado general (brillo, opacidad, uniformidad)",\n' +
  '  "imperfecciones": "texto breve: swirls, rayas, manchas, oxidación, etc. que se noten",\n' +
  '  "nivel_contaminacion": "texto breve: polvo, savia, alquitrán, sarro de agua, etc.",\n' +
  '  "tratamientos_recomendados": "texto breve con 1-3 tratamientos sugeridos (ej. corrección de pintura, sellado cerámico, detailing interior)",\n' +
  '  "prioridad": "Baja" | "Media" | "Alta"\n' +
  '}\n' +
  'Sé concreto y breve en cada campo (máximo 2 frases). No inventes daños que no se vean con claridad.';

// Extrae el primer objeto JSON válido de un string, por si el modelo
// agrega texto extra o fences de markdown a pesar de las instrucciones.
function extractJson(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('No JSON found in model response');
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const apiKey = process.env.GROQ_API_KEY_INSPECCION;
  if (!apiKey) {
    console.error('Falta la env var GROQ_API_KEY_INSPECCION en Vercel');
    return res.status(500).json({ error: 'Configuración del servidor incompleta' });
  }

  const { images } = req.body || {};

  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'Se requiere al menos una imagen' });
  }
  if (images.length > MAX_IMAGES) {
    return res.status(400).json({ error: `Máximo ${MAX_IMAGES} imágenes` });
  }
  if (images.some((img) => typeof img !== 'string' || !img.startsWith('data:image/'))) {
    return res.status(400).json({ error: 'Formato de imagen inválido' });
  }

  // Chequeo temprano de tamaño total (Groq corta en 4MB para base64 y devuelve 413).
  const approxBytes = images.reduce((sum, img) => sum + img.length * 0.75, 0);
  if (approxBytes > 4 * 1024 * 1024) {
    return res.status(413).json({ error: 'Las imágenes son demasiado pesadas en conjunto' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 700,
        reasoning_effort: 'none', // clave: sin esto el content trae ruido de "pensamiento" y rompe el JSON
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: SYSTEM_PROMPT },
              ...images.map((img) => ({ type: 'image_url', image_url: { url: img } })),
            ],
          },
        ],
      }),
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq API error:', groqRes.status, errText);
      return res.status(502).json({ error: 'Error al analizar las imágenes' });
    }

    const data = await groqRes.json();
    const raw = data?.choices?.[0]?.message?.content;

    if (!raw) {
      console.error('Respuesta de Groq sin content:', JSON.stringify(data));
      return res.status(502).json({ error: 'Respuesta vacía del modelo' });
    }

    let report;
    try {
      report = extractJson(raw);
    } catch (parseErr) {
      console.error('No se pudo parsear el JSON del modelo. raw:', raw);
      return res.status(502).json({ error: 'No se pudo interpretar la respuesta del modelo' });
    }

    return res.status(200).json({
      estado_pintura: report.estado_pintura || '',
      imperfecciones: report.imperfecciones || '',
      nivel_contaminacion: report.nivel_contaminacion || '',
      tratamientos_recomendados: report.tratamientos_recomendados || '',
      prioridad: report.prioridad || '',
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('Timeout esperando respuesta de Groq');
      return res.status(504).json({ error: 'La IA tardó demasiado en responder' });
    }
    console.error('Error en /api/inspeccion:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  } finally {
    clearTimeout(timeout);
  }
}
