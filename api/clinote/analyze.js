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

function digitsOnly(s) {
  return String(s || "").replace(/[^\d]/g, "");
}

function formatDpi(raw) {
  const d = digitsOnly(raw);
  if (!d) return "";
  if (d.length === 13) return `${d.slice(0, 4)} ${d.slice(4, 9)} ${d.slice(9)}`;
  return d;
}

function extractPatient(text) {
  const t = String(text || "");
  const out = {};

  const mName = t.match(/\b(?:paciente\s+)?(?:se\s+llama|nombre\s+del\s+paciente\s+es|nombre\s+es)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/i);
  if (mName) out.name = safeTrim(mName[1]);

  const mAge = t.match(/\btiene\s+(\d{1,3})\s*a(?:ñ|n)os?\b/i);
  if (mAge) out.age = safeTrim(mAge[1]);

  const mSex = t.match(/\bsexo\s*(?:es|:)?\s*(masculino|femenino|hombre|mujer)\b/i);
  if (mSex) {
    const v = mSex[1].toLowerCase();
    out.sex = v === "hombre" ? "Masculino" : v === "mujer" ? "Femenino" : v.charAt(0).toUpperCase() + v.slice(1);
  }

  const mDpi = t.match(/\b(?:dpi|documento\s+personal\s+de\s+identificaci[oó]n)\b\s*(?:es|:|n[uú]mero\s+es|n[uú]mero\s+de\s+)?\s*([\d\s\-]{10,})/i);
  if (mDpi) out.dpi = formatDpi(mDpi[1]);

  const mPhone = t.match(/\b(?:tel[eé]fono|celular)\b\s*(?:es|:)?\s*([\d\s\-]{8,})/i);
  if (mPhone) out.phone = safeTrim(mPhone[1]);

  const mRec = t.match(/\b(?:expediente|no\.\s*expediente|n[uú]mero\s+de\s+expediente)\b\s*(?:es|:)?\s*([\w\-]{3,})/i);
  if (mRec) out.record = safeTrim(mRec[1]);

  return out;
}

function extractVitals(text) {
  const t = String(text || "");
  const out = [];

  const mTemp = t.match(/\btemperatura\b(?:\s*(?:est[aá]\s*en|est[aá]|en|:))?\s*(\d{2}(?:[.,]\d)?)\b/i);
  if (mTemp) out.push(`Temp: ${mTemp[1].replace(",", ".")}°C`);

  const mBP =
    t.match(/\bpresi[oó]n\b(?:\s*(?:arterial)?)?(?:\s*(?:est[aá]\s*en|en|:))?\s*(\d{2,3})\s*(?:\/|\s|\-)\s*(\d{2,3})\b/i) ||
    t.match(/\b(?:PA|TA)\b\s*(\d{2,3})\s*(?:\/|\s|\-)\s*(\d{2,3})\b/i);
  if (mBP) out.push(`PA: ${mBP[1]}/${mBP[2]}`);

  const mFC = t.match(/\b(?:frecuencia\s+card[ií]aca|FC|pulso)\b(?:\s*(?:en|:|est[aá]\s*en))?\s*(\d{2,3})\b/i);
  if (mFC) out.push(`FC: ${mFC[1]}`);

  const mFR = t.match(/\b(?:frecuencia\s+respiratoria|FR)\b(?:\s*(?:en|:|est[aá]\s*en))?\s*(\d{1,2})\b/i);
  if (mFR) out.push(`FR: ${mFR[1]}`);

  const mSat = t.match(/\b(?:sat(?:uraci[oó]n)?\s*o2|spo2)\b(?:\s*(?:en|:|est[aá]\s*en))?\s*(\d{2,3})\b/i);
  if (mSat) out.push(`SatO2: ${mSat[1]}%`);

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

    // Auto-extracción de datos del paciente desde el texto (delta + contexto)
    const ctxText = safeTrim(
      `${delta} ${body?.input?.timeline_context || ""} ${body?.input?.transcript_context || ""}`
    );
    const patient = extractPatient(ctxText);


    const alerts = Array.isArray(body?.current?.alerts) ? body.current.alerts.slice(0, 20) : [];
    const questions = Array.isArray(body?.current?.questions) ? body.current.questions.slice(0, 20) : [];

    if (!delta) {
      res.status(200).json({ sections, alerts, questions, patient });
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

    res.status(200).json({ sections, alerts, questions, patient });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
};
