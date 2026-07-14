// /api/inspeccion.js
// Endpoint que recibe las fotos del formulario "Inspección digital" y las manda
// a Groq (modelo con visión) para generar un reporte preliminar del estado de la pintura.
//
// Requiere la variable de entorno GROQ_API_KEY_INSPECCION configurada en Vercel
// (Project Settings → Environment Variables). Nunca expongas esta key en el frontend.
// Usa un nombre distinto al de la key del chat (ej. GROQ_API_KEY_CHAT) para que
// cada endpoint tenga su propia key de Groq, con límites y uso independientes.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { images } = req.body || {};

  if (!Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ error: 'Se requiere al menos una imagen' });
  }

  if (images.length > 4) {
    return res.status(400).json({ error: 'Máximo 4 imágenes' });
  }

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY_INSPECCION}`
      },
      body: JSON.stringify({
        model: 'llama-3.2-11b-vision-preview',
        temperature: 0.3,
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Sos un experto en detailing automotriz. Analizá estas fotos de un vehículo y ' +
                  'generá un reporte PRELIMINAR (no es un diagnóstico definitivo, aclaralo si corresponde) ' +
                  'del estado de la pintura. Respondé EXCLUSIVAMENTE con un objeto JSON, sin texto adicional, ' +
                  'con esta forma exacta:\n' +
                  '{\n' +
                  '  "estado_pintura": "texto breve describiendo el estado general (brillo, opacidad, uniformidad)",\n' +
                  '  "imperfecciones": "texto breve: swirls, rayas, manchas, oxidación, etc. que se noten",\n' +
                  '  "nivel_contaminacion": "texto breve: polvo, savia, alquitrán, sarro de agua, etc.",\n' +
                  '  "tratamientos_recomendados": "texto breve con 1-3 tratamientos sugeridos (ej. corrección de pintura, sellado cerámico, detailing interior)",\n' +
                  '  "prioridad": "Baja" | "Media" | "Alta"\n' +
                  '}\n' +
                  'Sé concreto y breve en cada campo (máximo 2 frases). No inventes daños que no se vean con claridad.'
              },
              ...images.map((img) => ({
                type: 'image_url',
                image_url: { url: img }
              }))
            ]
          }
        ]
      })
    });

    if (!groqRes.ok) {
      const errText = await groqRes.text();
      console.error('Groq API error:', groqRes.status, errText);
      return res.status(502).json({ error: 'Error al analizar las imágenes' });
    }

    const data = await groqRes.json();
    const raw = data?.choices?.[0]?.message?.content;

    if (!raw) {
      return res.status(502).json({ error: 'Respuesta vacía del modelo' });
    }

    let report;
    try {
      report = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: 'No se pudo interpretar la respuesta del modelo' });
    }

    return res.status(200).json({
      estado_pintura: report.estado_pintura || '',
      imperfecciones: report.imperfecciones || '',
      nivel_contaminacion: report.nivel_contaminacion || '',
      tratamientos_recomendados: report.tratamientos_recomendados || '',
      prioridad: report.prioridad || ''
    });
  } catch (err) {
    console.error('Error en /api/inspeccion:', err);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}
