/**
 * Vercel Serverless Function: /api/clinote/analyze
 * Heurística (sin OpenAI) para estructurar texto clínico:
 * - Divide en segmentos
 * - Separa frases mixtas (tratamiento + diagnóstico)
 * - Asigna a secciones: motivo, signos, diagnóstico, receta, etc.
 * - Devuelve preguntas para aclarar (sin inventar dosis)
 *
 * IMPORTANTE:
 * - Este repo usa "type":"module" => ESM con export default.
 */
function safeTrim(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function splitSegments(text) {
  const t = safeTrim(text);
  if (!t) return [];
  return t
    .split(/[\.\n;]+/g)
    .map((x) => safeTrim(x))
    .filter(Boolean);
}

function detectSectionHeader(text) {
  const t = safeTrim(text);
  if (!t) return { key: null, cleaned: "" };

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

  for (const h of headers) {
    if (h.re.test(t)) {
      const cleaned = safeTrim(t.replace(h.re, ""));
      return { key: h.key, cleaned };
    }
  }
  return { key: null, cleaned: t };
}

function splitIfMixedRxDx(seg) {
  const l = seg.toLowerCase();
  const hasDx = l.includes("diagnos") || /\bdx\b/i.test(seg) || l.includes("impresi");
  const hasRx =
    l.includes("tratamiento") ||
    l.includes("receta") ||
    l.includes("prescrib") ||
    l.includes("se le deja") ||
    l.includes("se deja") ||
    l.includes("se indica") ||
    /\b\d+\s*mg\b/i.test(seg) ||
    l.includes("cada ") ||
    l.includes("por ") ||
    l.includes("días") ||
    l.includes("dias");

  if (hasDx && hasRx) {
    const idx = l.indexOf("diagnos");
    if (idx > 8) {
      const a = safeTrim(seg.slice(0, idx));
      const b = safeTrim(seg.slice(idx));
      return [a, b].filter(Boolean);
    }
  }
  return [seg];
}

function bestBucket(seg, fallbackKey = "impresion") {
  const s = seg.toLowerCase();
  const score = {
    motivo: 0,
    antecedentes: 0,
    impresion: 0,
    signos: 0,
    diagnostico: 0,
    prescripcion: 0,
    plan: 0,
    estudios: 0,
    referencias: 0,
    acuerdos: 0,
  };

  if (s.includes("diagnos") || /\bdx\b/.test(s) || s.includes("impresi") || s.includes("compatible con") || s.includes("se concluye"))
    score.diagnostico += 6;

  const meds = /(amoxicilina|azitromicina|ibuprofeno|paracetamol|acetaminof[eé]n|naproxeno|omeprazol|metformina|loratadina|salbutamol|prednisona)/i;
  if (meds.test(seg)) score.prescripcion += 6;

  if (
    s.includes("tratamiento") ||
    s.includes("receta") ||
    s.includes("prescrib") ||
    s.includes("se le deja") ||
    s.includes("se deja") ||
    s.includes("se indica") ||
    s.includes("medic") ||
    /\b\d+\s*mg\b/.test(s) ||
    /\bcada\s*\d+\s*(hora|horas)\b/.test(s) ||
    /\bpor\s*\d+\s*(d[ií]a|d[ií]as|semanas)\b/.test(s)
  ) score.prescripcion += 6;

  if (
    /\bta\b/.test(s) ||
    s.includes("presión") ||
    s.includes("mmhg") ||
    /\bfc\b/.test(s) ||
    /\bfr\b/.test(s) ||
    s.includes("pulso") ||
    s.includes("lpm") ||
    s.includes("rpm") ||
    s.includes("satur") ||
    s.includes("sat") ||
    s.includes("temper") ||
    /\b\d{2,3}\s*\/\s*\d{2,3}\b/.test(s)
  ) score.signos += 6;

  if (
    s.includes("anteced") ||
    s.includes("alerg") ||
    s.includes("hipert") ||
    s.includes("diab") ||
    s.includes("cirug") ||
    s.includes("asma") ||
    s.includes("medicación crónica") ||
    s.includes("medicacion cronica")
  ) score.antecedentes += 4;

  if (
    s.includes("dolor") ||
    s.includes("fiebre") ||
    s.includes("vómit") ||
    s.includes("vomit") ||
    s.includes("náuse") ||
    s.includes("nause") ||
    s.includes("diarre") ||
    s.includes("tos") ||
    s.includes("gargant") ||
    s.includes("cefale") ||
    s.includes("mareo") ||
    s.includes("cansancio") ||
    s.includes("deshidrat") ||
    s.includes("desde hace") ||
    s.includes("durante") ||
    s.includes("inicio de")
  ) score.motivo += 4;

  if (s.includes("laboratorio") || s.includes("rayos") || s.includes("rx") || s.includes("ultra") || s.includes("examen") || s.includes("prueba"))
    score.estudios += 4;

  if (s.includes("reposo") || s.includes("hidrat") || s.includes("control") || s.includes("seguimiento") || s.includes("retornar") || s.includes("cita"))
    score.plan += 3;

  if (s.includes("interconsulta") || s.includes("refer") || s.includes("especialista")) score.referencias += 3;

  if (s.includes("cuadro") || s.includes("compatible") || s.includes("sugiere") || s.includes("probable")) score.impresion += 2;

  let best = fallbackKey;
  let bestScore = 0;
  for (const [k, v] of Object.entries(score)) {
    if (v > bestScore) {
      bestScore = v;
      best = k;
    }
  }
  return bestScore > 0 ? best : fallbackKey;
}

function mergeAppend(sections, key, val) {
  const v = safeTrim(val);
  if (!v) return;
  sections[key] = safeTrim((sections[key] || "") + " " + v);
}

function analyzeDelta(deltaText, currentSections) {
  const sections = { ...(currentSections || {}) };
  const segs = splitSegments(deltaText);

  for (const seg0 of segs) {
    const h = detectSectionHeader(seg0);
    if (h.key) {
      mergeAppend(sections, h.key, h.cleaned);
      continue;
    }

    const pieces = splitIfMixedRxDx(seg0);
    for (const seg of pieces) {
      const bucket = bestBucket(seg, "impresion");
      mergeAppend(sections, bucket, seg);
    }
  }

  // Pequeño “complemento” seguro: si menciona medicamento sin dosis, se marca pendiente (no inventa)
  const rx = safeTrim(sections.prescripcion);
  if (rx) {
    const hasDose = /\b\d+\s*mg\b/i.test(rx) || /\bcada\s*\d+\s*(hora|horas)\b/i.test(rx) || /\bpor\s*\d+\s*d[ií]as\b/i.test(rx);
    const hasPending = /\bpendiente\b/i.test(rx);
    if (!hasDose && !hasPending) {
      sections.prescripcion = safeTrim(rx + " (dosis/frecuencia/duración: pendiente)");
    }
  }

  return sections;
}

function buildQuestions(sections) {
  const q = [];
  const dx = safeTrim(sections.diagnostico);
  const rx = safeTrim(sections.prescripcion);
  const vit = safeTrim(sections.signos);
  const mot = safeTrim(sections.motivo);

  if (mot && !vit) q.push("¿Se registraron signos vitales (TA, FC, FR, T°, SatO2)?");
  if (rx) {
    const hasDose = /\b\d+\s*mg\b/i.test(rx) || /\bcada\s*\d+\s*(hora|horas)\b/i.test(rx) || /\bpor\s*\d+\s*d[ií]as\b/i.test(rx);
    if (!hasDose) q.push("La prescripción no incluye dosis/frecuencia/duración. ¿Podés especificarlas?");
  }
  if (!dx) q.push("¿Cuál es el diagnóstico final?");
  if (mot && (mot.toLowerCase().includes("deshidrat") || mot.toLowerCase().includes("vómit") || mot.toLowerCase().includes("vomit"))) {
    q.push("¿Se indicó plan de hidratación y signos de alarma?");
  }

  return q.slice(0, 6);
}

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

    const baseSections = { ...(current.sections || {}) };
    const sections = delta ? analyzeDelta(delta, baseSections) : baseSections;

    const alerts = Array.isArray(current.alerts) ? current.alerts : [];
    const questions = buildQuestions(sections);

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sections, alerts, questions }));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e && e.message ? e.message : e));
  }
}
