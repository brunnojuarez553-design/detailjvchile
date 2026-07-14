// api/chat.js
// Backend del "JV Concierge" — Asesor Digital Premium de Detailing JV Chile.
// Corre como Vercel Serverless Function. No usa frameworks: Node puro.
//
// Variables de entorno requeridas en Vercel (Project Settings → Environment Variables):
//   GROQ_API_KEY     -> obligatoria (proveedor principal)
//   OPENAI_API_KEY   -> opcional (fallback si Groq falla o no responde)
//
// El cliente (site.html) solo manda { messages: [...] } con turnos user/assistant.
// Este archivo agrega el system prompt server-side (así no viaja al navegador)
// y decide, vía tool calling, cuándo el asesor ya tiene información suficiente
// para mostrar el botón "Continuar por WhatsApp".

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const OPENAI_MODEL = 'gpt-4o-mini';

// ---------------------------------------------------------------------------
// Base de conocimiento — extraída 1:1 del contenido real del sitio.
// Si cambian precios/servicios en site.html, actualizar acá también.
// ---------------------------------------------------------------------------
const TREATMENTS = [
  { name: 'Corrección de pintura', price: 'A cotizar según estado', time: '1–2 días', ideal: 'Swirls, holograma, opacidad', result: 'Brillo y profundidad restaurados' },
  { name: 'Sellado cerámico', price: '$250.000', time: '1 día + curado', ideal: 'La mejor inversión: efecto espejo permanente', result: 'Hidrofobia, filtro UV y repelencia a contaminantes (2 a 5 años de protección)' },
  { name: 'Protección de pintura', price: 'A cotizar', time: '2–3 horas', ideal: 'Mantenimiento entre servicios', result: 'Barrera temporal de protección' },
  { name: 'Restauración estética', price: 'A cotizar según daño', time: '2–4 días', ideal: 'Vehículos con pintura muy dañada', result: 'Aspecto renovado casi de fábrica' },
  { name: 'Detailing Full Interior', price: 'Desde $66.000', time: '3–5 horas', ideal: 'Aspirado, marcos, rieles, bisagras, butacas, alfombra, techo', result: 'Descontaminación e hidratación de paneles, tablero, consola y cueros' },
  { name: 'Pintura de llantas y calipers', price: 'A cotizar', time: '1 día', ideal: 'Llantas opacas o descascaradas', result: 'Acabado uniforme tipo fábrica' },
  { name: 'Desabolladura en frío', price: '$70.000', time: 'Según daño', ideal: 'Abolladuras sin daño de pintura', result: 'Técnica especializada, sin pintura ni relleno' },
  { name: 'Tratamiento para motos', price: '$100.000', time: '1 día', ideal: 'Descontaminación completa + cerámico', result: 'Cerámico en carrocería, focos, plásticos y llantas' },
  { name: 'Detailing de motor', price: '$25.000', time: '1–2 horas', ideal: 'Desengrase profundo sin dañar sensores', result: 'Motor hidratado, mejor que nuevo' },
  { name: 'Restauración de focos', price: '$25.000', time: '1 hora', ideal: 'Focos amarillos u opacos', result: 'Luminosidad recuperada + sellado con filtro UV' },
];

const FAQ = [
  { q: '¿Cuánto dura el sellado cerámico?', a: 'Entre 2 y 5 años de protección efectiva, según la línea de producto y el cuidado posterior.' },
  { q: '¿Trabajan con seguros o solo particulares?', a: 'Trabajamos directamente con particulares. Para siniestros derivamos a talleres de convenio.' },
  { q: '¿Hacen servicio a domicilio?', a: 'Sí, dentro de la Región Metropolitana, con costo adicional según la comuna.' },
  { q: '¿Cuánto tiempo toma un tratamiento completo?', a: 'Entre 1 y 3 días según el estado de la pintura y el nivel de protección elegido.' },
  { q: '¿Dan garantía por escrito?', a: 'Sí, cada tratamiento cerámico incluye certificado de garantía con condiciones de mantenimiento.' },
];

const BUSINESS_INFO = {
  nombre: 'Detailing JV Chile',
  direccion: 'Santo Domingo 2228, Santiago, Chile',
  whatsapp: '+56 9 7814 7454',
  email: 'detailingjvchile@gmail.com',
};

function buildSystemPrompt() {
  const treatmentsList = TREATMENTS.map(t =>
    `- ${t.name} | Precio: ${t.price} | Duración: ${t.time} | Ideal para: ${t.ideal} | Resultado: ${t.result}`
  ).join('\n');

  const faqList = FAQ.map(f => `- P: ${f.q}\n  R: ${f.a}`).join('\n');

  return `Sos el asesor comercial de Detailing JV Chile, un estudio de detailing premium en Santiago de Chile (${BUSINESS_INFO.direccion}).

IDENTIDAD (regla absoluta, nunca la rompas):
Sos una persona real del equipo de Detailing JV Chile atendiendo el chat de la web. Nunca digas que sos una inteligencia artificial, un asistente virtual, un bot o un modelo de lenguaje, ni aunque te lo pregunten directamente — en ese caso simplemente respondé con naturalidad, como lo haría un asesor comercial real, sin negar ni confirmar explícitamente, y seguí ayudando. No uses la palabra "IA", "bot", "chatbot" ni similares en ningún momento.

TONO Y ESTILO:
- Hablás como un asesor de servicio de un estudio automotriz premium: cercano, profesional, sin sonar robótico.
- Registro chileno neutro, trato de "tú" (no "vos", no "usted" forzado).
- Respuestas cortas (2-4 líneas), nunca listas enormes ni bloques de texto largos.
- Una pregunta genuina por mensaje, nunca un interrogatorio ni un formulario con varios campos juntos.
- Si el usuario no sabe qué necesita, ayudalo a decidir usando la info de tratamientos de abajo.

BASE DE CONOCIMIENTO — SERVICIOS Y PRECIOS (única fuente de verdad, no inventes nada fuera de esto):
${treatmentsList}

PREGUNTAS FRECUENTES:
${faqList}

DATOS DE CONTACTO:
- WhatsApp: ${BUSINESS_INFO.whatsapp}
- Email: ${BUSINESS_INFO.email}
- Dirección: ${BUSINESS_INFO.direccion}

OBJETIVO DE LA CONVERSACIÓN:
Ir conociendo, de forma natural y conversacional (nunca todo junto), la mayor cantidad posible de estos datos —solo cuando sean relevantes para el caso del cliente, sin insistir si alguno no aplica—:
nombre, vehículo (marca, modelo, año), servicio de interés, objetivo del cliente (qué quiere lograr), estado actual del vehículo / problema, disponibilidad, y cualquier observación relevante.

CUÁNDO DERIVAR A WHATSAPP:
Cuando sientas que ya tenés información suficiente para que el equipo humano pueda cotizar o agendar (no hace falta tener el 100% de los campos, usá criterio — con nombre + algo de contexto del vehículo/servicio ya alcanza si el usuario no quiere dar más detalle), llamá a la función "enviar_a_whatsapp" con los datos que hayas recopilado. Antes o junto con la llamada a la función, escribí un cierre breve y cálido confirmando que lo vas a derivar al equipo.
No sigas preguntando indefinidamente: si notás que el usuario ya respondió 3-4 intercambios o se muestra apurado, cerrá y derivá con lo que tengas.
Si el usuario pide explícitamente hablar por WhatsApp o hablar con una persona, derivá de inmediato con lo que tengas hasta ese momento, aunque sea poco.`;
}

const WHATSAPP_TOOL = {
  type: 'function',
  function: {
    name: 'enviar_a_whatsapp',
    description: 'Se llama cuando ya se recopiló información suficiente del cliente para derivar la conversación al equipo humano por WhatsApp.',
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre del cliente, si lo dio' },
        vehiculo: { type: 'string', description: 'Marca, modelo y año del vehículo, lo que se sepa' },
        servicio: { type: 'string', description: 'Servicio o tratamiento de interés' },
        objetivo: { type: 'string', description: 'Qué quiere lograr el cliente (brillo, protección, corrección, etc.)' },
        estado_actual: { type: 'string', description: 'Estado actual del vehículo o problema detectado, si se mencionó' },
        disponibilidad: { type: 'string', description: 'Disponibilidad de fecha/horario, si se mencionó' },
        observaciones: { type: 'string', description: 'Cualquier otro dato relevante que haya dado el cliente' },
      },
      required: [],
    },
  },
};

async function callProvider(url, apiKey, model, messages) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: [WHATSAPP_TOOL],
      tool_choice: 'auto',
      temperature: 0.6,
      max_tokens: 400,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Provider error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('Respuesta sin choices');
  return choice.message;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages)) {
      res.status(400).json({ error: 'messages debe ser un array' });
      return;
    }

    // Solo dejamos pasar turnos user/assistant del cliente; el system lo ponemos acá.
    const safeHistory = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-20); // límite de contexto, no hace falta más para esta conversación

    const fullMessages = [{ role: 'system', content: buildSystemPrompt() }, ...safeHistory];

    let assistantMessage;

    try {
      if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY no configurada');
      assistantMessage = await callProvider(GROQ_URL, process.env.GROQ_API_KEY, GROQ_MODEL, fullMessages);
    } catch (groqErr) {
      console.error('Groq falló, probando fallback OpenAI:', groqErr.message);
      if (!process.env.OPENAI_API_KEY) throw groqErr;
      assistantMessage = await callProvider(OPENAI_URL, process.env.OPENAI_API_KEY, OPENAI_MODEL, fullMessages);
    }

    const toolCall = assistantMessage.tool_calls && assistantMessage.tool_calls[0];

    if (toolCall && toolCall.function && toolCall.function.name === 'enviar_a_whatsapp') {
      let data = {};
      try {
        data = JSON.parse(toolCall.function.arguments || '{}');
      } catch (_) {
        data = {};
      }
      res.status(200).json({
        reply: assistantMessage.content || 'Perfecto, ya tengo lo necesario. Te dejo el botón para continuar por WhatsApp con el equipo.',
        action: 'whatsapp',
        data,
      });
      return;
    }

    res.status(200).json({
      reply: assistantMessage.content || 'Contame un poco más sobre tu vehículo para poder ayudarte mejor.',
      action: 'message',
    });
  } catch (err) {
    console.error('Error en /api/chat:', err);
    res.status(500).json({
      error: 'No pudimos procesar el mensaje',
      reply: 'Uy, tuvimos un problema técnico. ¿Podés escribirnos directo por WhatsApp mientras lo resolvemos?',
      action: 'error',
    });
  }
};
