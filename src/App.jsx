import React, { useEffect, useMemo, useRef, useState } from "react";
import jsPDF from "jspdf";

/**
 * APROFAM ClinNote — Prototipo (cliente) + análisis IA (backend)
 * - Dictado: Web Speech API (SpeechRecognition) en es-GT
 * - Auto-sección: si dictás "Diagnóstico: ..." cambia de sección y captura el contenido
 * - Heurística local + heurística backend: separa en Diagnóstico / Receta / Motivo / Signos, etc.
 * - PDF: descarga + vista previa (auto)
 *
 * Nota: el backend NO recibe audio, solo texto (delta_text).
 */

const SECTION_DEFS = [
  { key: "motivo", label: "Motivo de la consulta" },
  { key: "antecedentes", label: "Antecedentes" },
  { key: "impresion", label: "Impresión clínica" },
  { key: "signos", label: "Signos vitales" },
  { key: "diagnostico", label: "Diagnóstico" },
  { key: "prescripcion", label: "Prescripción / Receta" },
  { key: "plan", label: "Plan / Indicaciones" },
  { key: "estudios", label: "Estudios solicitados" },
  { key: "referencias", label: "Referencias / Interconsultas" },
  { key: "acuerdos", label: "Acuerdos / Próximos pasos" },
];

const DEFAULT_SECTIONS = SECTION_DEFS.reduce((acc, s) => {
  acc[s.key] = "";
  return acc;
}, {});

const STORAGE_KEY = "apro_clinote_state_v4";

function cn(...cls) {
  return cls.filter(Boolean).join(" ");
}

function safeTrim(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// --- Sugerencias CIE-10 (cliente, reglas simples) ---
// Nota: esto NO es un diagnóstico. Son sugerencias automáticas para apoyo clínico.
// Podés ampliar/ajustar estas reglas según tu práctica y el CIE-10 que uses (OMS/CM).
const ICD10_RULES = [
  {
    id: "headache",
    re: /(dolor\s+de\s+cabeza|cefalea|migrañ?a|jaqueca)/i,
    suggestions: [
      { code: "R51", title: "Cefalea" },
      { code: "G43.9", title: "Migraña, no especificada" },
      { code: "G44.2", title: "Cefalea tensional" },
      { code: "J01.9", title: "Sinusitis aguda, no especificada" },
    ],
  },
  {
    id: "sore_throat",
    re: /(dolor\s+de\s+garganta|odinofagia|faringitis|amigdalitis)/i,
    suggestions: [
      { code: "J02.9", title: "Faringitis aguda, no especificada" },
      { code: "J03.9", title: "Amigdalitis aguda, no especificada" },
      { code: "J06.9", title: "Infección aguda de vías respiratorias superiores, no especificada" },
    ],
  },
  {
    id: "fever",
    re: /(fiebre|febril|temperatura\s+alta)/i,
    suggestions: [
      { code: "R50.9", title: "Fiebre, no especificada" },
      { code: "J06.9", title: "Infección aguda de vías respiratorias superiores, no especificada" },
      { code: "A09", title: "Diarrea y gastroenteritis de presunto origen infeccioso" },
    ],
  },
  {
    id: "vomiting",
    re: /(v[oó]mito|n[aá]usea|emesis)/i,
    suggestions: [
      { code: "R11", title: "Náuseas y vómitos" },
      { code: "A09", title: "Diarrea y gastroenteritis de presunto origen infeccioso" },
      { code: "K52.9", title: "Gastroenteritis y colitis no infecciosa, no especificada" },
    ],
  },
];

function deriveIcd10Suggestions(text, max = 5) {
  const t = safeTrim(text || "");
  if (!t) return [];
  const out = [];
  for (const rule of ICD10_RULES) {
    if (rule.re.test(t)) {
      for (const s of rule.suggestions || []) {
        if (!out.some((x) => x.code === s.code)) out.push(s);
      }
    }
  }
  return out.slice(0, max);
}


function hexToRgb(hex) {
  const h = String(hex || "").replace("#", "").trim();
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    return { r, g, b };
  }
  if (h.length !== 6) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function setFillHex(doc, hex) {
  const { r, g, b } = hexToRgb(hex);
  doc.setFillColor(r, g, b);
}

function setTextHex(doc, hex) {
  const { r, g, b } = hexToRgb(hex);
  doc.setTextColor(r, g, b);
}

function truncateText(s, max = 180) {
  const t = safeTrim(s || "");
  if (!t) return "";
  return t.length > max ? t.slice(0, max - 1).trim() + "…" : t;
}

function buildStyledPdfDoc(meta, sections, transcript, extra = {}) {
  // Paleta APROFAM
  const C1 = "#1160C7"; // azul
  const C2 = "#FFC600"; // amarillo
  const C3 = "#00315E"; // azul fuerte
  const SOFT = "#F4F7FB";
  const TEXT = "#111827"; // slate-900
  const MUTED = "#6B7280"; // slate-500

  const doc = new jsPDF({ unit: "pt", format: "a4" });
  doc.setFont("helvetica", "normal");

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 44;
  const headerH = 46;
  const footerH = 26;
  const contentW = pageW - margin * 2;

  const drawHeader = () => {
    setFillHex(doc, C3);
    doc.rect(0, 0, pageW, headerH, "F");
    setFillHex(doc, C2);
    doc.rect(0, headerH - 4, pageW, 4, "F");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    setTextHex(doc, "#FFFFFF");
    doc.text("APROFAM ClinNote", margin, 28);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    setTextHex(doc, "#E5E7EB");
    const dt = meta?.datetimeLocal ? String(meta.datetimeLocal) : "";
    doc.text(dt, pageW - margin, 28, { align: "right" });
  };

  const addPage = () => {
    doc.addPage();
    drawHeader();
    return headerH + 18;
  };

  const ensureSpace = (y, needed = 0) => {
    if (y + needed > pageH - margin - footerH) {
      return addPage();
    }
    return y;
  };

  const drawInfoBox = (y) => {
    const boxH = 92;
    y = ensureSpace(y, boxH + 12);

    // fondo
    setFillHex(doc, SOFT);
    doc.roundedRect(margin, y, contentW, boxH, 10, 10, "F");

    // borde superior (azul)
    setFillHex(doc, C1);
    doc.roundedRect(margin, y, contentW, 6, 10, 10, "F");

    const x1 = margin + 14;
    const x2 = margin + contentW / 2 + 8;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    setTextHex(doc, C3);
    doc.text("DATOS DEL PACIENTE", x1, y + 22);
    doc.text("DATOS DE LA CONSULTA", x2, y + 22);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    setTextHex(doc, TEXT);

    const patientName = meta?.patientName ? String(meta.patientName) : "";
    const patientAge = meta?.patientAge ? String(meta.patientAge) : "";
    const patientSex = meta?.patientSex ? String(meta.patientSex) : "";
    const patientId = meta?.patientId ? String(meta.patientId) : "";
    const patientDpi = meta?.patientDpi ? String(meta.patientDpi) : "";
    const patientPhone = meta?.patientPhone ? String(meta.patientPhone) : "";

    const clinician = meta?.clinician ? String(meta.clinician) : "";
    const site = meta?.site ? String(meta.site) : "";
    const consent = meta?.consent ? "Sí" : "No";

    const leftLines = [
      patientName ? `Nombre: ${patientName}` : "Nombre: (sin registro)",
      (patientAge || patientSex) ? `Edad/Sexo: ${[patientAge || "—", patientSex || "—"].join(" / ")}` : "Edad/Sexo: (sin registro)",
      patientId ? `Expediente: ${patientId}` : "Expediente: (sin registro)",
      [patientDpi ? `DPI: ${patientDpi}` : "", patientPhone ? `Tel: ${patientPhone}` : ""].filter(Boolean).join("   "),
    ].filter(Boolean);

    const rightLines = [
      clinician ? `Médico: ${clinician}` : "Médico: (sin registro)",
      site ? `Sede: ${site}` : "Sede: (sin registro)",
      `Consentimiento: ${consent}`,
      extra?.aiUpdatedAt ? `Último análisis IA: ${String(extra.aiUpdatedAt)}` : "",
    ].filter(Boolean);

    let ly = y + 40;
    leftLines.forEach((ln) => {
      doc.text(String(ln), x1, ly);
      ly += 14;
    });

    let ry = y + 40;
    rightLines.forEach((ln) => {
      doc.text(String(ln), x2, ry);
      ry += 14;
    });

    return y + boxH + 18;
  };

  const drawSection = (y, title, body, opts = {}) => {
    const barH = 18;
    y = ensureSpace(y, barH + 10);

    // barra título
    setFillHex(doc, opts.barColor || C1);
    doc.roundedRect(margin, y, contentW, barH, 8, 8, "F");

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    setTextHex(doc, "#FFFFFF");
    doc.text(String(title || "").toUpperCase(), margin + 12, y + 13);

    y += barH + 8;

    // contenido
    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    setTextHex(doc, TEXT);

    const txt = safeTrim(body || "");
    const content = txt ? txt : "(sin registro)";
    const lines = doc.splitTextToSize(String(content), contentW - 8);

    for (let i = 0; i < lines.length; i++) {
      y = ensureSpace(y, 14);
      doc.text(String(lines[i] ?? ""), margin + 4, y);
      y += 14;
    }

    return y + 10;
  };

  const drawBullets = (y, title, bullets, opts = {}) => {
    if (!Array.isArray(bullets) || bullets.length === 0) return y;
    y = drawSection(y, title, "", { barColor: opts.barColor || C3 });

    doc.setFont("helvetica", "normal");
    doc.setFontSize(11);
    setTextHex(doc, TEXT);

    for (const b of bullets) {
      const btxt = safeTrim(b);
      if (!btxt) continue;
      const wrap = doc.splitTextToSize("• " + btxt, contentW - 8);
      for (let i = 0; i < wrap.length; i++) {
        y = ensureSpace(y, 14);
        doc.text(String(wrap[i] ?? ""), margin + 4, y);
        y += 14;
      }
      y += 2;
    }

    return y + 6;
  };

  // --- armado ---
  drawHeader();

  let y = headerH + 18;

  // Info boxes
  y = drawInfoBox(y);

  const ordered = [
    { key: "motivo", label: "Motivo de la consulta" },
    { key: "antecedentes", label: "Antecedentes" },
    { key: "impresion", label: "Impresión clínica" },
    { key: "signos", label: "Signos vitales" },
    { key: "diagnostico", label: "Diagnóstico" },
    { key: "prescripcion", label: "Prescripción / Receta" },
    { key: "plan", label: "Plan / Indicaciones" },
    { key: "estudios", label: "Estudios solicitados" },
    { key: "referencias", label: "Referencias / Interconsultas" },
    { key: "acuerdos", label: "Acuerdos / Próximos pasos" },
  ];

  for (const s of ordered) {
    y = drawSection(y, s.label, sections?.[s.key] || "");

    // CIE-10 sugerencias bajo diagnóstico
    if (s.key === "diagnostico") {
      const baseText = [sections?.motivo, sections?.impresion, sections?.diagnostico, sections?.prescripcion, transcript].filter(Boolean).join(" ");
      const sug = deriveIcd10Suggestions(baseText, 5);
      if (sug.length) {
        const list = sug.map((x) => `${x.code} — ${x.title}`);
        // Usamos barra amarilla con texto azul fuerte
        y = ensureSpace(y, 28);
        setFillHex(doc, C2);
        doc.roundedRect(margin, y, contentW, 18, 8, 8, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(10);
        setTextHex(doc, C3);
        doc.text("Sugerencias CIE-10 (referencia)", margin + 12, y + 13);
        y += 26;

        doc.setFont("helvetica", "normal");
        doc.setFontSize(11);
        setTextHex(doc, TEXT);

        for (const item of list) {
          const wrap = doc.splitTextToSize("• " + item, contentW - 8);
          for (let i = 0; i < wrap.length; i++) {
            y = ensureSpace(y, 14);
            doc.text(String(wrap[i] ?? ""), margin + 4, y);
            y += 14;
          }
          y += 2;
        }

        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        setTextHex(doc, MUTED);
        y = ensureSpace(y, 14);
        doc.text("Nota: esto NO es un diagnóstico. Es una referencia automática para apoyo clínico.", margin + 4, y);
        y += 18;
      }
    }
  }

  // Conclusión final (sin inventar: solo resume lo capturado)
  const bullets = [];
  const motivo = safeTrim(sections?.motivo || "");
  const impresion = safeTrim(sections?.impresion || "");
  const dx = safeTrim(sections?.diagnostico || "");
  const rx = safeTrim(sections?.prescripcion || "");
  const plan = safeTrim(sections?.plan || "");
  const estudios = safeTrim(sections?.estudios || "");
  const seguimiento = safeTrim(sections?.acuerdos || "");

  if (motivo) bullets.push(`Motivo: ${truncateText(motivo, 220)}`);
  if (impresion) bullets.push(`Impresión: ${truncateText(impresion, 220)}`);
  if (dx) bullets.push(`Diagnóstico documentado: ${truncateText(dx, 220)}`);
  if (rx) bullets.push(`Prescripción/Receta: ${truncateText(rx, 220)}`);
  if (plan) bullets.push(`Plan/Indicaciones: ${truncateText(plan, 220)}`);
  if (estudios) bullets.push(`Estudios solicitados: ${truncateText(estudios, 220)}`);
  if (seguimiento) bullets.push(`Seguimiento/Próximos pasos: ${truncateText(seguimiento, 220)}`);

  y = drawBullets(y, "Conclusión final", bullets, { barColor: C3 });

  // Transcripción completa como anexo (si existe)
  const t = safeTrim(transcript || "");
  if (t) {
    y = drawSection(y, "Anexo: Transcripción completa", t, { barColor: C1 });
  }

  // Footer en TODAS las páginas (con numeración)
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    // línea
    setFillHex(doc, "#E5E7EB");
    doc.rect(margin, pageH - margin - footerH + 6, contentW, 1, "F");

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    setTextHex(doc, C3);
    doc.text("Generado por APROFAM ClinNote — Revisar y validar antes de archivar.", margin, pageH - margin - 8);

    doc.setFontSize(9);
    setTextHex(doc, MUTED);
    doc.text(`Página ${p} de ${totalPages}`, pageW - margin, pageH - margin - 8, { align: "right" });
  }

  return doc;
}

function exportClinotePDF(meta, sections, transcript, extra = {}, filenameBase = "APROFAM_ClinNote") {
  const doc = buildStyledPdfDoc(meta, sections, transcript, extra);
  const date = new Date().toISOString().slice(0, 10);
  doc.save(`${filenameBase}_${date}.pdf`);
}

function pdfBlobUrlFromClinote(meta, sections, transcript, extra = {}) {
  const doc = buildStyledPdfDoc(meta, sections, transcript, extra);
  const blob = doc.output("blob");
  return URL.createObjectURL(blob);
}

function buildReport(meta, sections, transcript, extra = {}) {
  const lines = [];
  lines.push("INFORME DE CONSULTA (Borrador)");
  lines.push("—".repeat(34));
  lines.push(`Fecha/Hora: ${meta.datetimeLocal || ""}`);
  if (meta.clinician) lines.push(`Médico: ${meta.clinician}`);
  if (meta.site) lines.push(`Sede: ${meta.site}`);
  if (meta.patientName) lines.push(`Paciente: ${meta.patientName}`);
  const demo = [meta.patientAge ? `Edad: ${meta.patientAge}` : "", meta.patientSex ? `Sexo: ${meta.patientSex}` : ""].filter(Boolean).join(" | ");
  if (demo) lines.push(demo);
  const ids = [meta.patientId ? `Expediente: ${meta.patientId}` : "", meta.patientDpi ? `DPI: ${meta.patientDpi}` : "", meta.patientPhone ? `Tel: ${meta.patientPhone}` : ""].filter(Boolean).join(" | ");
  if (ids) lines.push(ids);
  if (meta.consent) lines.push("Consentimiento: Registrado");
  if (extra.aiUpdatedAt) lines.push(`Último análisis IA: ${extra.aiUpdatedAt}`);
  lines.push("");

  const ordered = [
    "motivo",
    "antecedentes",
    "impresion",
    "signos",
    "diagnostico",
    "prescripcion",
    "plan",
    "estudios",
    "referencias",
    "acuerdos",
  ];

  ordered.forEach((k) => {
  const def = SECTION_DEFS.find((x) => x.key === k);
  if (!def) return;
  const txt = safeTrim(sections[k]);
  lines.push(def.label.toUpperCase());
  lines.push(txt ? txt : "(sin registro)");

  // Sugerencias CIE-10 (solo referencia)
  if (
    k === "diagnostico" &&
    Array.isArray(extra.icd10Suggestions) &&
    extra.icd10Suggestions.length
  ) {
    lines.push("");
    lines.push("SUGERENCIAS CIE-10 (REFERENCIA)");
    extra.icd10Suggestions.forEach((s) => {
      lines.push(`- ${s.code} — ${s.title}`);
    });
    lines.push("Nota: Sugerencias automáticas; validar con criterio clínico.");
  }

  lines.push("");
});

  if (Array.isArray(extra.alerts) && extra.alerts.length) {
    lines.push("ALERTAS / VALIDACIONES (IA)");
    extra.alerts.forEach((a) => lines.push(`- ${a}`));
    lines.push("");
  }

  if (Array.isArray(extra.questions) && extra.questions.length) {
    lines.push("PREGUNTAS PARA ACLARAR (IA)");
    extra.questions.forEach((q) => lines.push(`- ${q}`));
    lines.push("");
  }

  const t = safeTrim(transcript);
  if (t) {
    lines.push("TRANSCRIPCIÓN COMPLETA");
    lines.push(t);
  }

  return lines.join("\n");
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

function splitSegments(text) {
  const t = safeTrim(text);
  if (!t) return [];
  return t
    .split(/[\.\n;]+/g)
    .map((x) => safeTrim(x))
    .filter(Boolean);
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

  // Diagnóstico
  if (s.includes("diagnos") || /\bdx\b/.test(s) || s.includes("impresi") || s.includes("compatible con") || s.includes("se concluye"))
    score.diagnostico += 6;

  // Medicamentos (pequeña lista + heurística)
  const meds = /(amoxicilina|azitromicina|ibuprofeno|paracetamol|acetaminof[eé]n|naproxeno|omeprazol|metformina|loratadina|salbutamol|prednisona)/i;
  if (meds.test(seg)) score.prescripcion += 6;

  // Receta / prescripción
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

  // Signos vitales
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

  // Antecedentes
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

  // Motivo / síntomas
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
    s.includes("inicio de") ||
    s.includes("desde hace") ||
    s.includes("durante")
  ) score.motivo += 4;

  // Estudios
  if (s.includes("laboratorio") || s.includes("rayos") || s.includes("rx") || s.includes("ultra") || s.includes("examen") || s.includes("prueba"))
    score.estudios += 4;

  // Plan / indicaciones
  if (s.includes("reposo") || s.includes("hidrat") || s.includes("control") || s.includes("seguimiento") || s.includes("retornar") || s.includes("cita"))
    score.plan += 3;

  // Referencias / interconsulta
  if (s.includes("interconsulta") || s.includes("refer") || s.includes("especialista")) score.referencias += 3;

  // Impresión (fallback si describe cuadro)
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

function smartDistributeText(prev, text, fallbackKey) {
  const next = { ...prev };
  const segs = splitSegments(text);
  let did = false;

  for (const seg0 of segs) {
    // 1) Encabezados explícitos (Diagnóstico:, Receta:, etc.)
    const h = detectSectionHeader(seg0);
    if (h.key) {
      const cleaned = safeTrim(h.cleaned);
      if (cleaned) next[h.key] = safeTrim(`${next[h.key] || ""} ${cleaned}`);
      did = true;
      continue;
    }

    // 2) Oración mixta (tratamiento + diagnóstico)
    const pieces = splitIfMixedRxDx(seg0);
    for (const seg of pieces) {
      const bucket = bestBucket(seg, fallbackKey || "impresion");
      next[bucket] = safeTrim(`${next[bucket] || ""} ${seg}`);
      did = true;
    }
  }

  return { next, did };
}

export default function App() {
  const SpeechRecognition =
    typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  // ---- Estados UI ----
  const [mode, setMode] = useState("section"); // section | free
  const [activeSection, setActiveSection] = useState("motivo");
  const [autoSection, setAutoSection] = useState(true);
  const [persistLocal, setPersistLocal] = useState(true);
  const [pdfPreview, setPdfPreview] = useState(true);

  // ---- IA ----
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiStatus, setAiStatus] = useState("idle"); // idle | analyzing | error
  const [aiError, setAiError] = useState("");
  const [aiSections, setAiSections] = useState({ ...DEFAULT_SECTIONS });
  const [aiAlerts, setAiAlerts] = useState([]);
  const [aiQuestions, setAiQuestions] = useState([]);
  const [aiUpdatedAt, setAiUpdatedAt] = useState("");

  // ---- Dictado ----
  const [isListening, setIsListening] = useState(false);
  const [supportsSpeech, setSupportsSpeech] = useState(!!SpeechRecognition);
  const [permissionError, setPermissionError] = useState("");
  const [interim, setInterim] = useState("");

  // ---- Datos ----
  const [meta, setMeta] = useState({
    datetimeLocal: new Date().toLocaleString("es-GT"),
    clinician: "",
    site: "",
    // Datos del paciente (opcionales)
    patientName: "",
    patientAge: "",
    patientSex: "",
    patientDpi: "",
    patientPhone: "",
    patientId: "", // No. expediente / ID interno
    consent: false,
  });

  const [sections, setSections] = useState({ ...DEFAULT_SECTIONS });
  const [fullTranscript, setFullTranscript] = useState("");
  const [timeline, setTimeline] = useState([]); // {ts, section, text}

  // ---- Vista previa PDF ----
  const [pdfUrl, setPdfUrl] = useState("");
  const pdfUrlRef = useRef("");

  // ---- Refs ----
  const recognitionRef = useRef(null);
  const shouldListenRef = useRef(false);

  const modeRef = useRef(mode);
  const activeSectionRef = useRef(activeSection);
  const autoSectionRef = useRef(autoSection);
  const aiEnabledRef = useRef(aiEnabled);

  const metaRef = useRef(meta);
  const timelineRef = useRef(timeline);
  const transcriptRef = useRef(fullTranscript);
  const aiSectionsRef = useRef(aiSections);
  const aiAlertsRef = useRef(aiAlerts);
  const aiQuestionsRef = useRef(aiQuestions);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { activeSectionRef.current = activeSection; }, [activeSection]);
  useEffect(() => { autoSectionRef.current = autoSection; }, [autoSection]);
  useEffect(() => { aiEnabledRef.current = aiEnabled; }, [aiEnabled]);

  useEffect(() => { metaRef.current = meta; }, [meta]);
  useEffect(() => { timelineRef.current = timeline; }, [timeline]);
  useEffect(() => { transcriptRef.current = fullTranscript; }, [fullTranscript]);
  useEffect(() => { aiSectionsRef.current = aiSections; }, [aiSections]);
  useEffect(() => { aiAlertsRef.current = aiAlerts; }, [aiAlerts]);
  useEffect(() => { aiQuestionsRef.current = aiQuestions; }, [aiQuestions]);

  // ---- Cola IA ----
  const pendingTextRef = useRef([]);
  const aiTimerRef = useRef(null);
  const aiInFlightRef = useRef(false);

  const enqueueAI = (text) => {
    if (!aiEnabledRef.current) return;
    const t = safeTrim(text);
    if (!t) return;

    pendingTextRef.current.push(t);

    if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    aiTimerRef.current = setTimeout(() => {
      flushAI();
    }, 700);
  };

  const flushAI = async () => {
    if (!aiEnabledRef.current) return;
    if (aiInFlightRef.current) return;

    const batch = pendingTextRef.current;
    if (!batch.length) return;

    aiInFlightRef.current = true;
    setAiStatus("analyzing");
    setAiError("");

    const ctxTimeline = (timelineRef.current || []).slice(-25).map((t) => t.text).join(" ");
    const ctxTranscript = safeTrim(transcriptRef.current || "").slice(-5000);
    const delta = batch.join(" ");
    pendingTextRef.current = [];

    try {
      const res = await fetch("/api/clinote/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          meta: metaRef.current,
          current: {
            sections: aiSectionsRef.current,
            alerts: aiAlertsRef.current,
            questions: aiQuestionsRef.current,
          },
          input: {
            delta_text: delta,
            timeline_context: ctxTimeline,
            transcript_context: ctxTranscript,
          },
        }),
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || `HTTP ${res.status}`);
      }

      const data = await res.json();
      if (data?.sections) setAiSections((p) => ({ ...p, ...data.sections }));
      if (Array.isArray(data?.alerts)) setAiAlerts(data.alerts);
      if (Array.isArray(data?.questions)) setAiQuestions(data.questions);
      setAiUpdatedAt(new Date().toLocaleString("es-GT"));
      setAiStatus("idle");
    } catch (e) {
      setAiStatus("error");
      setAiError(e?.message ? String(e.message).slice(0, 500) : "Error IA");
      pendingTextRef.current = [delta, ...pendingTextRef.current];
    } finally {
      aiInFlightRef.current = false;
    }
  };

  // ---- Reportes ----

const icd10Suggestions = useMemo(() => {
  // Fuente principal: motivo/impresión/diagnóstico + transcripción.
  // Si IA está activa, tomamos sus campos (más “limpios”); si no, los manuales.
  const src = aiEnabled ? aiSections : sections;

  const ctx = safeTrim(
    [
      src.motivo,
      src.antecedentes,
      src.impresion,
      src.signos,
      src.diagnostico,
      src.prescripcion,
      fullTranscript,
    ].join(" ")
  );

  return deriveIcd10Suggestions(ctx, 6);
}, [aiEnabled, aiSections, sections, fullTranscript]);


  const reportManual = useMemo(
    () => buildReport(meta, sections, fullTranscript, { icd10Suggestions }),
    [meta, sections, fullTranscript, icd10Suggestions]
  );

  const reportAI = useMemo(
    () => buildReport(meta, aiSections, fullTranscript, { aiUpdatedAt, alerts: aiAlerts, questions: aiQuestions, icd10Suggestions }),
    [meta, aiSections, fullTranscript, aiUpdatedAt, aiAlerts, aiQuestions]
  );

  const effectiveReport = aiEnabled ? reportAI : reportManual;

  // ---- PDF en tiempo real (preview) ----
  useEffect(() => {
    if (!pdfPreview) {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      pdfUrlRef.current = "";
      setPdfUrl("");
      return;
    }

    const pdfSections = aiEnabled ? aiSections : sections;
    const pdfExtra = aiEnabled ? { aiUpdatedAt } : {};

    const t = setTimeout(() => {
      try {
        const url = pdfBlobUrlFromClinote(meta, pdfSections, fullTranscript, pdfExtra);
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
        pdfUrlRef.current = url;
        setPdfUrl(url);
      } catch {
        // ignore
      }
    }, 700);

    return () => clearTimeout(t);
  }, [pdfPreview, meta, aiEnabled, aiSections, sections, fullTranscript, aiUpdatedAt]);

  const sectionCompleteness = useMemo(() => {
    const required = ["motivo", "antecedentes", "impresion", "signos", "diagnostico", "prescripcion"];
    const src = aiEnabled ? aiSections : sections;
    const done = required.filter((k) => safeTrim(src[k]).length > 0).length;
    return { done, total: required.length };
  }, [aiEnabled, aiSections, sections]);

  // ---- Cargar / guardar local ----
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);

      if (s?.meta) setMeta((p) => ({ ...p, ...s.meta }));
      if (s?.sections) setSections((p) => ({ ...p, ...s.sections }));
      if (s?.aiSections) setAiSections((p) => ({ ...p, ...s.aiSections }));
      if (typeof s?.fullTranscript === "string") setFullTranscript(s.fullTranscript);
      if (Array.isArray(s?.timeline)) setTimeline(s.timeline);
      if (s?.mode) setMode(s.mode);
      if (s?.activeSection) setActiveSection(s.activeSection);
      if (typeof s?.autoSection === "boolean") setAutoSection(s.autoSection);
      if (typeof s?.persistLocal === "boolean") setPersistLocal(s.persistLocal);
      if (typeof s?.aiEnabled === "boolean") setAiEnabled(s.aiEnabled);
      if (typeof s?.pdfPreview === "boolean") setPdfPreview(s.pdfPreview);
      if (Array.isArray(s?.aiAlerts)) setAiAlerts(s.aiAlerts);
      if (Array.isArray(s?.aiQuestions)) setAiQuestions(s.aiQuestions);
      if (typeof s?.aiUpdatedAt === "string") setAiUpdatedAt(s.aiUpdatedAt);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!persistLocal) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            meta,
            sections,
            aiSections,
            fullTranscript,
            timeline,
            mode,
            activeSection,
            autoSection,
            persistLocal,
            aiEnabled,
            pdfPreview,
            aiAlerts,
            aiQuestions,
            aiUpdatedAt,
            savedAt: new Date().toISOString(),
          })
        );
      } catch {
        // ignore
      }
    }, 250);

    return () => clearTimeout(t);
  }, [
    meta,
    sections,
    aiSections,
    fullTranscript,
    timeline,
    mode,
    activeSection,
    autoSection,
    persistLocal,
    aiEnabled,
    pdfPreview,
    aiAlerts,
    aiQuestions,
    aiUpdatedAt,
  ]);

  // ---- Support ----
  useEffect(() => {
    setSupportsSpeech(!!SpeechRecognition);
  }, [SpeechRecognition]);

  // ---- Crear recognition SOLO una vez ----
  useEffect(() => {
    if (!SpeechRecognition) return;

    const rec = new SpeechRecognition();
    rec.lang = "es-GT";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let finalChunk = "";
      let interimChunk = "";

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const txt = res[0]?.transcript || "";
        if (res.isFinal) finalChunk += txt;
        else interimChunk += txt;
      }

      const finalRaw = safeTrim(finalChunk);
      const interimTxt = safeTrim(interimChunk);
      setInterim(interimTxt);

      if (!finalRaw) return;

      const stamp = new Date().toLocaleTimeString("es-GT");

      // Siempre guardamos transcripción completa
      setFullTranscript((prev) => safeTrim(`${prev} ${finalRaw}`));

      // Timeline
      setTimeline((prev) => [
        ...prev,
        {
          ts: stamp,
          section: modeRef.current === "section" ? activeSectionRef.current : "(libre)",
          text: finalRaw,
        },
      ]);

      // Auto-sección (solo setea activeSection; la distribución la hace smartDistributeText)
      if (modeRef.current === "section" && autoSectionRef.current) {
        const d = detectSectionHeader(finalRaw);
        if (d.key) setActiveSection(d.key);
      }

      const fallbackKey = modeRef.current === "section" ? activeSectionRef.current : "impresion";

      // Distribución local (para NO dejar todo en un solo campo)
      setSections((prev) => smartDistributeText(prev, finalRaw, fallbackKey).next);

      // UI: si IA está activa, también actualiza aiSections inmediatamente (luego backend lo mejora)
      if (aiEnabledRef.current) {
        setAiSections((prev) => smartDistributeText(prev, finalRaw, fallbackKey).next);
      }

      // Backend IA (opcional)
      enqueueAI(finalRaw);
    };

    rec.onerror = (e) => {
      const msg = e?.error ? String(e.error) : "Error desconocido";
      setPermissionError(msg);

      const transient = ["no-speech", "aborted", "audio-capture", "network"];
      if (shouldListenRef.current && transient.includes(msg)) {
        try { recognitionRef.current?.stop(); } catch {}
        setTimeout(() => {
          if (!shouldListenRef.current) return;
          try {
            recognitionRef.current?.start();
            setIsListening(true);
          } catch {
            setIsListening(false);
          }
        }, 450);
        return;
      }

      shouldListenRef.current = false;
      setIsListening(false);
    };

    rec.onend = () => {
      setIsListening(false);
      setInterim("");

      if (shouldListenRef.current) {
        setTimeout(() => {
          if (!shouldListenRef.current) return;
          try {
            recognitionRef.current?.start();
            setIsListening(true);
          } catch {
            // ignore
          }
        }, 250);
      }
    };

    recognitionRef.current = rec;

    return () => {
      try { rec.stop(); } catch {}
      recognitionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [SpeechRecognition]);

  const requestMicPermission = async () => {
    setPermissionError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch (err) {
      const name = err?.name || "Error";
      if (name === "NotAllowedError") {
        setPermissionError("Permiso denegado. En el candado de la URL poné Micrófono: Permitir y recargá.");
      } else if (name === "SecurityError") {
        setPermissionError("Contexto no seguro. Abrilo en https o en http://localhost (NO file://).");
      } else if (name === "NotReadableError") {
        setPermissionError("El micrófono está ocupado por otra app (Teams/Zoom) o el driver falló.");
      } else if (name === "NotFoundError") {
        setPermissionError("No se detecta micrófono (desconectado o deshabilitado).");
      } else {
        setPermissionError("No se pudo acceder al micrófono. Revisa permisos del navegador.");
      }
      return false;
    }
  };

  const start = async () => {
    setPermissionError("");
    if (!supportsSpeech) return;

    const ok = await requestMicPermission();
    if (!ok) return;

    shouldListenRef.current = true;

    try {
      recognitionRef.current?.start();
      setIsListening(true);
    } catch (e) {
      try { recognitionRef.current?.stop(); } catch {}
      setTimeout(() => {
        if (!shouldListenRef.current) return;
        try {
          recognitionRef.current?.start();
          setIsListening(true);
        } catch {
          setPermissionError("No se pudo iniciar el dictado. Probá recargar la página.");
          shouldListenRef.current = false;
          setIsListening(false);
        }
      }, 250);
    }
  };

  const stop = () => {
    shouldListenRef.current = false;
    try { recognitionRef.current?.stop(); } catch {}
    setIsListening(false);
    setInterim("");
    setTimeout(() => flushAI(), 0);
  };

  const toggleMic = () => {
    if (isListening) stop();
    else start();
  };

  const clearAll = () => {
    setSections({ ...DEFAULT_SECTIONS });
    setAiSections({ ...DEFAULT_SECTIONS });
    setAiAlerts([]);
    setAiQuestions([]);
    setAiUpdatedAt("");
    setFullTranscript("");
    setInterim("");
    setTimeline([]);
    pendingTextRef.current = [];

    if (persistLocal) {
      try { localStorage.removeItem(STORAGE_KEY); } catch {}
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  };

  const exportPDF = () => {
    const pdfSections = aiEnabled ? aiSections : sections;
    const pdfExtra = aiEnabled ? { aiUpdatedAt } : {};
    exportClinotePDF(
      meta,
      pdfSections,
      fullTranscript,
      pdfExtra,
      aiEnabled ? "APROFAM_ClinNote_IA" : "APROFAM_ClinNote"
    );
  };

  // UI source: si IA está activa, editás sobre la estructura IA
  const uiSections = aiEnabled ? aiSections : sections;
  const setUiSectionValue = (key, value) => {
    if (aiEnabled) setAiSections((p) => ({ ...p, [key]: value }));
    else setSections((p) => ({ ...p, [key]: value }));
  };

  // ---- Neumorphism ----
  const BG = "bg-[#e6ebf2]";
  const CARD = "bg-[#e6ebf2] shadow-[10px_10px_20px_rgba(163,177,198,0.55),-10px_-10px_20px_rgba(255,255,255,0.9)]";
  const INSET = "bg-[#e6ebf2] shadow-[inset_8px_8px_16px_rgba(163,177,198,0.55),inset_-8px_-8px_16px_rgba(255,255,255,0.9)]";
  const BTN = "bg-[#e6ebf2] shadow-[8px_8px_16px_rgba(163,177,198,0.55),-8px_-8px_16px_rgba(255,255,255,0.9)] hover:shadow-[6px_6px_12px_rgba(163,177,198,0.55),-6px_-6px_12px_rgba(255,255,255,0.9)] active:shadow-[inset_6px_6px_12px_rgba(163,177,198,0.55),inset_-6px_-6px_12px_rgba(255,255,255,0.9)]";
  const BTN_PRIMARY = "bg-slate-900 text-white hover:bg-slate-800 active:bg-slate-950";
  const BTN_DANGER = "bg-rose-600 text-white hover:bg-rose-700 active:bg-rose-800";

  return (
    <div
      className={cn("min-h-screen", BG, "text-slate-900")}
      style={{
        backgroundImage:
          "radial-gradient(circle at 20% 10%, rgba(255,255,255,0.6), transparent 45%), radial-gradient(circle at 80% 0%, rgba(255,255,255,0.5), transparent 40%)",
      }}
    >
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <header className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-800">APROFAM ClinNote</h1>
            <p className="text-sm text-slate-600">Aplicación para tomar notas clínicas.</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded-full px-3 py-1 text-xs font-semibold", INSET, supportsSpeech ? "text-emerald-700" : "text-amber-700")}>
              {supportsSpeech ? "SpeechRecognition disponible" : "SpeechRecognition no disponible"}
            </span>
            <span className={cn("rounded-full px-3 py-1 text-xs font-semibold text-slate-700", INSET)}>
              Campos clave: {sectionCompleteness.done}/{sectionCompleteness.total}
            </span>
          </div>
        </header>

        {permissionError && (
          <div className={cn("mb-4 rounded-2xl p-4 text-sm text-rose-900", CARD)}>
            <div className="font-semibold">Aviso</div>
            <div className="mt-1 break-words">{permissionError}</div>
          </div>
        )}

        {aiEnabled && aiStatus === "error" && (
          <div className={cn("mb-4 rounded-2xl p-4 text-sm text-rose-900", CARD)}>
            <div className="font-semibold">Error IA</div>
            <div className="mt-1 break-words">{aiError || "Error desconocido"}</div>
            <div className="mt-2 text-xs text-slate-700">
              Si estás en local (Vite) sin Vercel, podés desactivar “Analizar con IA (backend)” y usar solo la heurística local.
            </div>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-12">
          {/* Panel izquierdo */}
          <div className="lg:col-span-4">
            <div className={cn("rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">Control</h2>

              <div className="mt-3 grid gap-3">
                <label className="text-xs font-semibold text-slate-600">Modo</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setMode("section")}
                    className={cn("flex-1 rounded-xl px-3 py-2 text-sm font-semibold", BTN, mode === "section" ? BTN_PRIMARY : "text-slate-800")}
                  >
                    Por secciones
                  </button>
                  <button
                    onClick={() => setMode("free")}
                    className={cn("flex-1 rounded-xl px-3 py-2 text-sm font-semibold", BTN, mode === "free" ? BTN_PRIMARY : "text-slate-800")}
                  >
                    Libre
                  </button>
                </div>

                {mode === "section" && (
                  <div>
                    <label className="text-xs font-semibold text-slate-600">Sección activa</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <select
                        value={activeSection}
                        onChange={(e) => setActiveSection(e.target.value)}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      >
                        {SECTION_DEFS.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <p className="mt-2 text-xs text-slate-500">
                      Tip: podés dictar “Diagnóstico: …” o “Receta: …” y se ordena solo.
                    </p>
                  </div>
                )}

                <div className={cn("rounded-xl p-3 text-xs text-slate-700", INSET)}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold">Estado</div>
                      <div className="mt-1">{isListening ? "Escuchando…" : "Inactivo"}</div>
                      <div className="mt-1">
                        IA:{" "}
                        <span className="font-semibold">
                          {aiEnabled ? (aiStatus === "analyzing" ? "Analizando…" : "Activa") : "Apagada"}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={toggleMic}
                      disabled={!supportsSpeech}
                      className={cn(
                        "rounded-xl px-3 py-2 text-sm font-semibold",
                        BTN,
                        isListening ? BTN_DANGER : "bg-emerald-600 text-white hover:bg-emerald-700",
                        !supportsSpeech ? "cursor-not-allowed opacity-60" : ""
                      )}
                    >
                      {isListening ? "Detener" : "Iniciar"}
                    </button>
                  </div>

                  {interim && (
                    <div className="mt-2">
                      <div className="font-semibold">Interim</div>
                      <div className="mt-1 italic">{interim}</div>
                    </div>
                  )}
                </div>

                <div className="grid gap-2">
                  <button onClick={() => copyToClipboard(effectiveReport)} className={cn("rounded-xl px-3 py-2 text-sm font-semibold", BTN, BTN_PRIMARY)}>
                    Copiar informe
                  </button>
                  <button onClick={exportPDF} className={cn("rounded-xl px-3 py-2 text-sm font-semibold text-slate-800", BTN)}>
                    Descargar PDF
                  </button>
                  <button onClick={clearAll} className={cn("rounded-xl px-3 py-2 text-sm font-semibold text-rose-700", BTN)}>
                    Limpiar todo
                  </button>
                </div>

                <div className="grid gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={autoSection} onChange={(e) => setAutoSection(e.target.checked)} className="h-4 w-4 rounded" />
                    <span className="text-sm text-slate-700">Auto-sección por encabezados</span>
                  </label>

                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={persistLocal} onChange={(e) => setPersistLocal(e.target.checked)} className="h-4 w-4 rounded" />
                    <span className="text-sm text-slate-700">Guardar local (este navegador)</span>
                  </label>

                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={aiEnabled} onChange={(e) => setAiEnabled(e.target.checked)} className="h-4 w-4 rounded" />
                    <span className="text-sm text-slate-700">Analizar con IA (backend)</span>
                  </label>

                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={pdfPreview} onChange={(e) => setPdfPreview(e.target.checked)} className="h-4 w-4 rounded" />
                    <span className="text-sm text-slate-700">Vista previa PDF (auto)</span>
                  </label>
                </div>
              </div>
            </div>

            <div className={cn("mt-4 rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">Metadatos</h2>
              <div className="mt-3 grid gap-3">
                <label className="text-xs font-semibold text-slate-600">Fecha/Hora</label>
                <div className={cn("rounded-xl px-3 py-2", INSET)}>
                  <input value={meta.datetimeLocal} onChange={(e) => setMeta((p) => ({ ...p, datetimeLocal: e.target.value }))} className="w-full bg-transparent text-sm text-slate-800 outline-none" />
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs font-semibold text-slate-600">Médico</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input value={meta.clinician} onChange={(e) => setMeta((p) => ({ ...p, clinician: e.target.value }))} className="w-full bg-transparent text-sm text-slate-800 outline-none" />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-600">Sede</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input value={meta.site} onChange={(e) => setMeta((p) => ({ ...p, site: e.target.value }))} className="w-full bg-transparent text-sm text-slate-800 outline-none" />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-600">Nombre del paciente</label>
                  <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                    <input
                      value={meta.patientName}
                      onChange={(e) => setMeta((p) => ({ ...p, patientName: e.target.value }))}
                      className="w-full bg-transparent text-sm text-slate-800 outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs font-semibold text-slate-600">Edad</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input
                        value={meta.patientAge}
                        onChange={(e) => setMeta((p) => ({ ...p, patientAge: e.target.value }))}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-600">Sexo</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <select
                        value={meta.patientSex}
                        onChange={(e) => setMeta((p) => ({ ...p, patientSex: e.target.value }))}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      >
                        <option value="">(sin registro)</option>
                        <option value="F">F</option>
                        <option value="M">M</option>
                        <option value="Otro">Otro</option>
                      </select>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs font-semibold text-slate-600">DPI</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input
                        value={meta.patientDpi}
                        onChange={(e) => setMeta((p) => ({ ...p, patientDpi: e.target.value }))}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-slate-600">Teléfono</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input
                        value={meta.patientPhone}
                        onChange={(e) => setMeta((p) => ({ ...p, patientPhone: e.target.value }))}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-600">No. expediente / ID</label>
                  <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                    <input
                      value={meta.patientId}
                      onChange={(e) => setMeta((p) => ({ ...p, patientId: e.target.value }))}
                      className="w-full bg-transparent text-sm text-slate-800 outline-none"
                    />
                  </div>
                </div>
</div>

                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={meta.consent} onChange={(e) => setMeta((p) => ({ ...p, consent: e.target.checked }))} className="h-4 w-4 rounded" />
                  <span className="text-sm text-slate-700">Consentimiento registrado</span>
                </label>
              </div>
            </div>
          </div>

          {/* Panel derecho */}
          <div className="lg:col-span-8">
            <div className={cn("rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">
                Nota clínica ({aiEnabled ? "IA" : "manual"})
              </h2>

              <div className="mt-4 grid gap-3">
                {SECTION_DEFS.map((s) => (
                  <div
                    key={s.key}
                    className={cn(
                      "rounded-2xl p-3",
                      INSET,
                      activeSection === s.key && mode === "section" ? "outline outline-2 outline-slate-700" : ""
                    )}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-slate-800">{s.label}</div>
                      {mode === "section" && (
                        <button
                          onClick={() => setActiveSection(s.key)}
                          className={cn(
                            "rounded-full px-3 py-1 text-xs font-semibold",
                            BTN,
                            activeSection === s.key ? BTN_PRIMARY : "text-slate-800"
                          )}
                        >
                          {activeSection === s.key ? "Activa" : "Activar"}
                        </button>
                      )}
                    </div>

                    <textarea
                      value={uiSections[s.key]}
                      onChange={(e) => setUiSectionValue(s.key, e.target.value)}
                      rows={s.key === "motivo" ? 3 : 4}
                      className="mt-2 w-full resize-y rounded-xl bg-transparent px-2 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-500"
                      placeholder={`Escribí o dictá aquí: ${s.label}`}
                    />

{s.key === "diagnostico" && icd10Suggestions.length > 0 && (
  <div className={cn("mt-3 rounded-xl p-3 text-xs text-slate-700", INSET)}>
    <div className="font-semibold">Sugerencias CIE-10 (referencia)</div>
    <div className="mt-1 text-[11px] text-slate-500">
      Generadas desde lo dictado/escrito. No sustituyen criterio clínico.
    </div>

    <ul className="mt-2 space-y-2">
      {icd10Suggestions.slice(0, 6).map((d) => (
        <li key={d.code} className="flex items-start justify-between gap-3">
          <div className="leading-snug">
            <span className="font-semibold">{d.code}</span>{" "}
            <span className="text-slate-600">—</span> {d.title}
          </div>
          <button
            onClick={() => {
              const line = `${d.code} — ${d.title}`;
              setSections((p) => ({
                ...p,
                diagnostico: safeTrim(`${p.diagnostico} ${line}`),
              }));
              setAiSections((p) => ({
                ...p,
                diagnostico: safeTrim(`${p.diagnostico} ${line}`),
              }));
            }}
            className={cn("shrink-0 rounded-lg px-3 py-1 text-xs font-semibold", BTN, "text-slate-800")}
            title="Agregar a Diagnóstico"
          >
            Agregar
          </button>
        </li>
      ))}
    </ul>
  </div>
)}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div className={cn("rounded-2xl p-4", CARD)}>
                <h2 className="text-sm font-semibold text-slate-700">Transcripción</h2>
                <div className={cn("mt-3 rounded-xl p-3", INSET)}>
                  <textarea
                    value={fullTranscript}
                    onChange={(e) => setFullTranscript(e.target.value)}
                    rows={10}
                    className="w-full resize-y bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-500"
                  />
                </div>
              </div>

              <div className={cn("rounded-2xl p-4", CARD)}>
                <h2 className="text-sm font-semibold text-slate-700">Informe IA (exportable)</h2>
                <div className={cn("mt-3 rounded-xl p-3", INSET)}>
                  <textarea value={reportAI} readOnly rows={10} className="w-full resize-y bg-transparent text-sm text-slate-800 outline-none" />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button onClick={() => copyToClipboard(reportAI)} className={cn("rounded-xl px-3 py-2 text-sm font-semibold", BTN, BTN_PRIMARY)}>
                    Copiar IA
                  </button>
                  <button onClick={exportPDF} className={cn("rounded-xl px-3 py-2 text-sm font-semibold text-slate-800", BTN)}>
                    Descargar PDF
                  </button>
                </div>
              </div>
            </div>

            {pdfPreview && (
              <div className={cn("mt-4 rounded-2xl p-4", CARD)}>
                <h2 className="text-sm font-semibold text-slate-700">PDF en tiempo real</h2>
                <p className="mt-1 text-xs text-slate-600">Se actualiza solo (cada ~1 segundo) con el informe actual.</p>
                <div className={cn("mt-3 rounded-xl overflow-hidden", INSET)}>
                  {pdfUrl ? (
                    <iframe title="PDF preview" src={pdfUrl} className="h-[520px] w-full" />
                  ) : (
                    <div className="p-3 text-sm text-slate-600">(Generando PDF…)</div>
                  )}
                </div>
              </div>
            )}

            <div className={cn("mt-4 rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">Línea de tiempo</h2>
              <div className={cn("mt-3 max-h-72 overflow-auto rounded-xl p-2", INSET)}>
                {timeline.length === 0 ? (
                  <div className="p-2 text-sm text-slate-600">(Aún sin registros)</div>
                ) : (
                  <ul className="space-y-2">
                    {timeline.slice().reverse().map((item, idx) => (
                      <li key={`${item.ts}-${idx}`} className={cn("rounded-xl p-3", BG, "shadow-[4px_4px_10px_rgba(163,177,198,0.35),-4px_-4px_10px_rgba(255,255,255,0.75)]")}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold text-slate-700", INSET)}>{item.ts}</span>
                        </div>
                        <div className="mt-1 text-sm text-slate-800">{item.text}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            

          </div>
        </div>
      </div>

      {/* Botón flotante mic */}
      <button
        onClick={toggleMic}
        disabled={!supportsSpeech}
        className={cn(
          "fixed bottom-5 right-5 h-14 w-14 rounded-full text-xl font-bold",
          BTN,
          isListening ? "bg-rose-600 text-white" : "bg-emerald-600 text-white",
          !supportsSpeech ? "cursor-not-allowed opacity-60" : ""
        )}
        title={isListening ? "Detener" : "Iniciar"}
      >
        {isListening ? "■" : "🎤"}
      </button>
    </div>
  );
}
