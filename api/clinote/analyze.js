/**
 * Vercel Serverless Function: /api/clinote/analyze
 * Heurística (sin OpenAI) para que el modo IA no falle:
 * - Detecta encabezados tipo "Diagnóstico: ..." y actualiza secciones.
 * - Si no detecta, agrega el texto al campo más probable según palabras clave.
 *
 * IMPORTANTE:
 * - Este repo usa package.json con "type":"module" => este archivo debe ser ESM.
 * - Por eso exportamos con `export default`.
 */
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      return res.end("Method Not Allowed");
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const current = body.current || {};
    const input = body.input || {};
    const delta = String(input.delta_text || "").trim();

    const sections = Object.assign({}, current.sections || {});
    const alerts = Array.isArray(current.alerts) ? current.alerts : [];
    const questions = Array.isArray(current.questions) ? current.questions : [];

    if (!delta) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ sections, alerts, questions }));
    }

    const safeTrim = (s) => String(s || "").replace(/\s+/g, " ").trim();

    const headers = [
      { key: "motivo", re: /^(motivo(\s+de(\s+la)?)?\s+(consulta|la\s+consulta|de\s+consulta)?)(\s*[:\-])\s*/i },
      { key: "antecedentes", re: /^(antecedentes|historia\s+cl[ií]nica|hx)(\s*[:\-])\s*/i },
      { key: "impresion", re: /^(impresi[oó]n(\s+cl[ií]nica)?)(\s*[:\-])\s*/i },
      { key: "signos", re: /^(signos\s+vitales|vitales)(\s*[:\-])\s*/i },
      { key: "diagnostico", re: /^(diagn[oó]stico|dx)(\s*[:\-])\s*/i },
      { key: "prescripcion", re: /^(prescripci[oó]n|receta|medicaci[oó]n)(\s*[:\-])\s*/i },
      { key: "plan", re: /^(plan|indicaciones)(\s*[:\-])\s*/i },
      { key: "estudios", re: /^(estudios\s+solicitados|laboratorio|imagenolog[ií]a|ex[aá]menes)(\s*[:\-])\s*/i },
      { key: "referencias", re: /^(referencias|interconsulta|referir)(\s*[:\-])\s*/i },
      { key: "acuerdos", re: /^(acuerdos|pr[oó]ximos\s+pasos|seguimiento)(\s*[:\-])\s*/i },
    ];

    let updated = false;
    for (const h of headers) {
      if (h.re.test(delta)) {
        const cleaned = safeTrim(delta.replace(h.re, ""));
        sections[h.key] = safeTrim((sections[h.key] || "") + " " + cleaned);
        updated = true;
        break;
      }
    }

    if (!updated) {
      const d = delta.toLowerCase();
      const pick =
        d.includes("ta") || d.includes("presión") || d.includes("pulso") || d.includes("temperatura") || d.includes("satur")
          ? "signos"
          : d.includes("dx") || d.includes("diagnos") || d.includes("impresión")
          ? "diagnostico"
          : d.includes("receta") || d.includes("mg") || d.includes("cada") || d.includes("tableta") || d.includes("inyec")
          ? "prescripcion"
          : d.includes("laboratorio") || d.includes("ultra") || d.includes("rayos") || d.includes("imagen")
          ? "estudios"
          : "impresion";

      sections[pick] = safeTrim((sections[pick] || "") + " " + delta);
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sections, alerts, questions }));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e && e.message ? e.message : e));
  }
}
