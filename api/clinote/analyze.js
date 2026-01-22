// Vercel Serverless Function: /api/clinote/analyze
// Heurística simple (NO usa OpenAI). Estructura texto en secciones.

function safeTrim(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function mergeText(oldTxt, newTxt) {
  const a = safeTrim(oldTxt);
  const b = safeTrim(newTxt);
  if (!b) return a;
  if (!a) return b;
  // Evitar duplicación burda
  if (a.toLowerCase().includes(b.toLowerCase())) return a;
  return `${a} ${b}`.trim();
}

function detectHeader(t) {
  const text = safeTrim(t);
  const headers = [
    { key: "motivo", re: /^(motivo(\s+de(\s+la)?)?\s+(consulta|la\s+consulta|de\s+consulta)?)(\s*[:\-])\s*/i },
    { key: "antecedentes", re: /^(antecedentes|historia\s+cl[ií]nica|hx)(\s*[:\-])\s*/i },
    { key: "impresion", re: /^(impresi[oó]n(\s+cl[ií]nica)?)(\s*[:\-])\s*/i },
    { key: "signos", re: /^(signos\s+vitales|vitales)(\s*[:\-])\s*/i },
    { key: "diagnostico", re: /^(diagn[oó]stico|dx)(\s*[:\-])\s*/i },
    { key: "prescripcion", re: /^(prescripci[oó]n|receta|medicaci[oó]n|tratamiento)(\s*[:\-])\s*/i },
    { key: "plan", re: /^(plan|indicaciones)(\s*[:\-])\s*/i },
    { key: "estudios", re: /^(estudios\s+solicitados|laboratorio|imagenolog[ií]a|ex[aá]menes)(\s*[:\-])\s*/i },
    { key: "referencias", re: /^(referencias|interconsulta|referir)(\s*[:\-])\s*/i },
    { key: "acuerdos", re: /^(acuerdos|pr[oó]ximos\s+pasos|seguimiento)(\s*[:\-])\s*/i },
  ];

  for (const h of headers) {
    if (h.re.test(text)) {
      return { key: h.key, cleaned: safeTrim(text.replace(h.re, "")) };
    }
  }
  return { key: null, cleaned: text };
}

function extractVitals(text) {
  const t = text;
  const out = [];
  const pa = t.match(/\b(PA|TA)\s*(\d{2,3})\s*[\/\-]\s*(\d{2,3})\b/i);
  if (pa) out.push(`PA: ${pa[2]}/${pa[3]}`);
  const fc = t.match(/\b(FC|pulso)\s*(\d{2,3})\b/i);
  if (fc) out.push(`FC: ${fc[2]}`);
  const fr = t.match(/\b(FR)\s*(\d{1,2})\b/i);
  if (fr) out.push(`FR: ${fr[2]}`);
  const temp = t.match(/\b(temp(?:eratura)?)\s*(\d{2}(?:\.\d)?)\b/i);
  if (temp) out.push(`Temp: ${temp[1] ? temp[1] : temp[2]}°C`.replace("undefined", temp[2]));
  const sat = t.match(/\b(sat(?:uraci[oó]n)?\s*o2|spo2)\s*(\d{2,3})\b/i);
  if (sat) out.push(`SatO2: ${sat[2]}%`);
  return out.length ? out.join(" · ") : "";
}

function extractDx(text) {
  const t = text;
  // "diagnóstico es ..." o "dx ..."
  const m = t.match(/\b(diagn[oó]stico\s*(?:es|:)|dx\s*:?)\s*([^\.\n]+)/i);
  return m ? safeTrim(m[2]) : "";
}

function extractRx(text) {
  const t = text;
  const m = t.match(/\b(tratamiento|receta|prescripci[oó]n|se\s+indica|se\s+deja(?:r[aá])?\s+de\s+tratamiento)\b\s*:?\s*([^\.\n]+)/i);
  return m ? safeTrim(m[2]) : "";
}

function extractMedicationsLoose(text) {
  const meds = [
    "amoxicilina",
    "azitromicina",
    "ibuprofeno",
    "paracetamol",
    "acetaminofen",
    "loratadina",
    "omeprazol",
    "diclofenaco",
    "naproxeno",
    "metformina",
  ];
  const t = text.toLowerCase();
  const found = meds.filter((m) => t.includes(m));
  return found.length ? `Medicamentos mencionados: ${found.join(", ")}` : "";
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    const delta = safeTrim(body?.input?.delta_text || "");
    const current = body?.current?.sections || {};

    const sections = { ...current };
    const alerts = Array.isArray(body?.current?.alerts) ? body.current.alerts.slice(0, 20) : [];
    const questions = Array.isArray(body?.current?.questions) ? body.current.questions.slice(0, 20) : [];

    if (!delta) {
      res.status(200).json({ sections, alerts, questions });
      return;
    }

    // 1) Si viene encabezado explícito
    const h = detectHeader(delta);
    if (h.key) {
      if (h.cleaned) sections[h.key] = mergeText(sections[h.key], h.cleaned);
    } else {
      // 2) Extraer signos vitales
      const vit = extractVitals(delta);
      if (vit) sections.signos = mergeText(sections.signos, vit);

      // 3) Extraer diagnóstico
      const dx = extractDx(delta);
      if (dx) sections.diagnostico = mergeText(sections.diagnostico, dx);

      // 4) Extraer receta / tratamiento
      const rx = extractRx(delta);
      if (rx) sections.prescripcion = mergeText(sections.prescripcion, rx);

      // 5) Si menciona medicamentos sin decir "receta" explícito
      const medsLoose = extractMedicationsLoose(delta);
      if (medsLoose && !rx) sections.prescripcion = mergeText(sections.prescripcion, medsLoose);

      // 6) Si no clasificó, manda a motivo/impresión
      const hasAny = vit || dx || rx || medsLoose;
      if (!hasAny) {
        // Si ya hay motivo, entonces va a impresión
        if (safeTrim(sections.motivo)) sections.impresion = mergeText(sections.impresion, delta);
        else sections.motivo = mergeText(sections.motivo, delta);
      }
    }

    // Preguntas mínimas
    if (!safeTrim(sections.diagnostico) && /dolor|fiebre|vomit|diarrea|tos|cefalea|mareo/i.test(delta)) {
      if (!questions.includes("Confirmar diagnóstico principal y descartar signos de alarma.")) {
        questions.push("Confirmar diagnóstico principal y descartar signos de alarma.");
      }
    }

    res.status(200).json({ sections, alerts, questions });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
};
