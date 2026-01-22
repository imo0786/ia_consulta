import React, { useEffect, useMemo, useRef, useState } from "react";
import jsPDF from "jspdf";

// Paleta APROFAM
const C_DARK = "#00315E";
const C_BLUE = "#1160C7";
const C_YELLOW = "#FFC600";

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

const STORAGE_KEY = "apro_clinnote_state_v1";

function cn(...cls) {
  return cls.filter(Boolean).join(" ");
}

function safeTrim(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function hexToRgb(hex) {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function setFill(doc, hex) {
  const { r, g, b } = hexToRgb(hex);
  doc.setFillColor(r, g, b);
}
function setText(doc, hex) {
  const { r, g, b } = hexToRgb(hex);
  doc.setTextColor(r, g, b);
}
function setDraw(doc, hex) {
  const { r, g, b } = hexToRgb(hex);
  doc.setDrawColor(r, g, b);
}

function buildConclusion(sections) {
  // No inventa: solo resume lo existente.
  const motivo = safeTrim(sections.motivo);
  const dx = safeTrim(sections.diagnostico);
  const rx = safeTrim(sections.prescripcion);
  const plan = safeTrim(sections.plan);

  const parts = [];
  if (motivo) parts.push(`Consulta por: ${motivo}.`);
  if (dx) parts.push(`Impresión/Diagnóstico: ${dx}.`);
  if (rx) parts.push(`Tratamiento/Receta indicada: ${rx}.`);
  if (plan) parts.push(`Plan/Indicaciones: ${plan}.`);

  return parts.length ? parts.join(" ") : "(Pendiente de completar información clínica)";
}

function wrapText(doc, text, x, y, maxW, lineH) {
  const lines = doc.splitTextToSize(String(text || ""), maxW);
  let yy = y;
  for (const ln of lines) {
    doc.text(String(ln ?? ""), x, yy);
    yy += lineH;
  }
  return yy;
}

function addSection(doc, title, body, opts) {
  const { pageW, pageH, margin, cursorY, brandBar = C_BLUE } = opts;
  let y = cursorY;

  const maxW = pageW - margin * 2;
  const lineH = 14;

  // salto de página si no cabe header
  if (y > pageH - margin - 40) {
    doc.addPage();
    y = margin;
  }

  // barra
  setFill(doc, brandBar);
  doc.roundedRect(margin, y, maxW, 22, 8, 8, "F");
  setText(doc, "#FFFFFF");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(title, margin + 10, y + 15);

  y += 30;

  // cuerpo
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  setText(doc, "#111827");

  const content = safeTrim(body) ? body : "(sin registro)";

  // cálculo y salto por líneas
  const lines = doc.splitTextToSize(String(content), maxW);
  for (const ln of lines) {
    if (y > pageH - margin - 18) {
      doc.addPage();
      y = margin;
    }
    doc.text(String(ln ?? ""), margin, y);
    y += lineH;
  }

  return y + 6;
}

function addFooter(doc, pageNum, pageCount) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  setText(doc, "#475569");
  doc.text(`APROFAM ClinNote • Página ${pageNum}/${pageCount}`, 44, pageH - 24);
}

function buildBrandedPdf({ meta, patient, clinician, site, sections, transcript, suggestions }) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 44;

  // Header
  setFill(doc, C_DARK);
  doc.rect(0, 0, pageW, 92, "F");
  setFill(doc, C_YELLOW);
  doc.rect(0, 92, pageW, 8, "F");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  setText(doc, "#FFFFFF");
  doc.text("APROFAM ClinNote", margin, 38);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10.5);
  setText(doc, "#E5E7EB");
  doc.text("Aplicación para tomar notas clínicas.", margin, 58);

  // Meta resumen
  setText(doc, "#FFFFFF");
  doc.setFontSize(10);
  const m1 = `Fecha/Hora: ${meta?.datetimeLocal || ""}`;
  const m2 = `Médico: ${clinician || meta?.clinician || ""}`;
  const m3 = `Sede: ${site || meta?.site || ""}`;
  doc.text(m1, pageW - margin - doc.getTextWidth(m1), 30);
  doc.text(m2, pageW - margin - doc.getTextWidth(m2), 48);
  doc.text(m3, pageW - margin - doc.getTextWidth(m3), 66);

  // Tarjeta paciente
  let y = 118;
  const cardW = pageW - margin * 2;
  setFill(doc, "#F8FAFC");
  setDraw(doc, "#E2E8F0");
  doc.roundedRect(margin, y, cardW, 92, 12, 12, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  setText(doc, C_BLUE);
  doc.text("Datos del paciente", margin + 14, y + 22);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  setText(doc, "#0F172A");

  const p = patient || {};
  const col1X = margin + 14;
  const col2X = margin + cardW / 2 + 6;
  const row1 = y + 42;
  const row2 = y + 60;
  const row3 = y + 78;

  const f = (label, val) => `${label}: ${val || ""}`;
  doc.text(f("Nombre", p.name), col1X, row1);
  doc.text(f("Edad", p.age), col2X, row1);
  doc.text(f("Sexo", p.sex), col1X, row2);
  doc.text(f("DPI", p.dpi), col2X, row2);
  doc.text(f("Teléfono", p.phone), col1X, row3);
  doc.text(f("No. expediente", p.record), col2X, row3);

  y += 112;

  // Secciones clínicas
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

  for (const k of ordered) {
    const def = SECTION_DEFS.find((x) => x.key === k);
    if (!def) continue;

    y = addSection(doc, def.label.toUpperCase(), sections?.[k] || "", {
      pageW,
      pageH,
      margin,
      cursorY: y,
      brandBar: k === "diagnostico" ? C_DARK : C_BLUE,
    });

    // Sugerencias CIE-10 bajo diagnóstico
    if (k === "diagnostico" && Array.isArray(suggestions) && suggestions.length) {
      const sugText = suggestions
        .slice(0, 6)
        .map((s) => `• ${s.code} — ${s.title}`)
        .join("\n");
      y = addSection(doc, "Sugerencias CIE-10 (referencia)", sugText, {
        pageW,
        pageH,
        margin,
        cursorY: y,
        brandBar: C_YELLOW,
      });
    }
  }

  // Conclusión
  y = addSection(doc, "CONCLUSIÓN", buildConclusion(sections || {}), {
    pageW,
    pageH,
    margin,
    cursorY: y,
    brandBar: C_DARK,
  });

  // Transcripción
  const t = safeTrim(transcript);
  if (t) {
    y = addSection(doc, "TRANSCRIPCIÓN COMPLETA", t, {
      pageW,
      pageH,
      margin,
      cursorY: y,
      brandBar: "#334155",
    });
  }

  // Footer en todas las páginas
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    addFooter(doc, i, total);
  }

  return doc;
}

function pdfBlobUrlFromDoc(doc) {
  const blob = doc.output("blob");
  return URL.createObjectURL(blob);
}

// --------------------
// Auto-sección (encabezados)
function detectSectionHeader(text) {
  const t = safeTrim(text);
  if (!t) return { key: null, cleaned: "" };

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
    if (h.re.test(t)) {
      const cleaned = safeTrim(t.replace(h.re, ""));
      return { key: h.key, cleaned };
    }
  }

  return { key: null, cleaned: t };
}

// --------------------
// Sugerencias CIE-10 (reglas simples)
const ICD10_RULES = [
  {
    id: "headache",
    triggers: [/\bdolor\s+de\s+cabeza\b/i, /\bcefalea\b/i, /\bmigra(ñ|n)a\b/i, /\bdolor\s+de\s+cr[aá]neo\b/i],
    suggestions: [
      { code: "R51", title: "Cefalea" },
      { code: "G43.9", title: "Migraña, no especificada" },
      { code: "G44.2", title: "Cefalea tensional, no especificada" },
    ],
  },
  {
    id: "sorethroat",
    triggers: [/\bdolor\s+de\s+garganta\b/i, /\bfaringitis\b/i, /\bamigdalitis\b/i],
    suggestions: [
      { code: "J02.9", title: "Faringitis aguda, no especificada" },
      { code: "J03.90", title: "Amigdalitis aguda, no especificada" },
      { code: "J06.9", title: "Infección aguda de vías respiratorias superiores, no especificada" },
    ],
  },
  {
    id: "fever",
    triggers: [/\bfiebre\b/i, /\btemperatura\s+alta\b/i],
    suggestions: [
      { code: "R50.9", title: "Fiebre, no especificada" },
      { code: "B34.9", title: "Infección viral, no especificada" },
      { code: "A09", title: "Gastroenteritis y colitis de origen infeccioso, no especificada" },
    ],
  },
];

function deriveIcd10SuggestionsFromText(text) {
  const t = safeTrim(text);
  if (!t) return [];

  const hits = [];
  for (const rule of ICD10_RULES) {
    if (rule.triggers.some((re) => re.test(t))) {
      hits.push(...rule.suggestions);
    }
  }

  // unique por code
  const seen = new Set();
  return hits.filter((s) => {
    const key = s.code;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default function App() {
  const SpeechRecognition =
    typeof window !== "undefined" &&
    (window.SpeechRecognition || window.webkitSpeechRecognition);

  // UI
  const [mode, setMode] = useState("section");
  const [activeSection, setActiveSection] = useState("motivo");
  const [autoSection, setAutoSection] = useState(true);
  const [persistLocal, setPersistLocal] = useState(true);
  const [pdfPreview, setPdfPreview] = useState(true);

  // Dictado
  const [isListening, setIsListening] = useState(false);
  const [supportsSpeech, setSupportsSpeech] = useState(!!SpeechRecognition);
  const [permissionError, setPermissionError] = useState("");
  const [interim, setInterim] = useState("");

  // Audio (grabación + MP3 en backend)
  const streamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const [mp3Url, setMp3Url] = useState("");
  const [mp3Busy, setMp3Busy] = useState(false);
  const [mp3Error, setMp3Error] = useState("");
  const [mp3Info, setMp3Info] = useState({ filename: "", size: 0 });


  // Datos
  const [meta, setMeta] = useState({
    datetimeLocal: new Date().toLocaleString("es-GT"),
    clinician: "",
    site: "",
    consent: false,
  });

  const [patient, setPatient] = useState({
    name: "",
    age: "",
    sex: "",
    dpi: "",
    phone: "",
    record: "",
  });

  const [sections, setSections] = useState({ ...DEFAULT_SECTIONS });
  const [fullTranscript, setFullTranscript] = useState("");
  const [timeline, setTimeline] = useState([]);

  // Sugerencias
  const [icd10Suggestions, setIcd10Suggestions] = useState([]);

  // PDF preview
  const [pdfUrl, setPdfUrl] = useState("");
  const pdfUrlRef = useRef("");

  // Refs
  const recognitionRef = useRef(null);
  const modeRef = useRef(mode);
  const activeSectionRef = useRef(activeSection);
  const autoSectionRef = useRef(autoSection);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { activeSectionRef.current = activeSection; }, [activeSection]);
  useEffect(() => { autoSectionRef.current = autoSection; }, [autoSection]);

  // Persistencia
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s?.meta) setMeta((p) => ({ ...p, ...s.meta }));
      if (s?.patient) setPatient((p) => ({ ...p, ...s.patient }));
      if (s?.sections) setSections((p) => ({ ...p, ...s.sections }));
      if (typeof s?.fullTranscript === "string") setFullTranscript(s.fullTranscript);
      if (Array.isArray(s?.timeline)) setTimeline(s.timeline);
      if (s?.mode) setMode(s.mode);
      if (s?.activeSection) setActiveSection(s.activeSection);
      if (typeof s?.autoSection === "boolean") setAutoSection(s.autoSection);
      if (typeof s?.persistLocal === "boolean") setPersistLocal(s.persistLocal);
      if (typeof s?.pdfPreview === "boolean") setPdfPreview(s.pdfPreview);
    } catch {}
  }, []);

  useEffect(() => {
    if (!persistLocal) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            meta,
            patient,
            sections,
            fullTranscript,
            timeline,
            mode,
            activeSection,
            autoSection,
            persistLocal,
            pdfPreview,
            savedAt: new Date().toISOString(),
          })
        );
      } catch {}
    }, 300);
    return () => clearTimeout(t);
  }, [meta, patient, sections, fullTranscript, timeline, mode, activeSection, autoSection, persistLocal, pdfPreview]);

  useEffect(() => {
    setSupportsSpeech(!!SpeechRecognition);
  }, [SpeechRecognition]);

  // Recognition (una vez)
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

      let target = activeSectionRef.current;
      let toInsert = finalRaw;

      if (autoSectionRef.current) {
        const d = detectSectionHeader(finalRaw);
        if (d.key) {
          target = d.key;
          toInsert = d.cleaned || "";
          setActiveSection(d.key);
        }
      }

      setTimeline((prev) => [...prev, { ts: stamp, section: modeRef.current === "section" ? target : "(libre)", text: finalRaw }]);

      if (modeRef.current === "section") {
        setSections((prev) => ({ ...prev, [target]: safeTrim(`${prev[target]} ${toInsert}`) }));
      } else {
        setFullTranscript((prev) => safeTrim(`${prev} ${finalRaw}`));
      }

      // Sugerencias CIE-10 por texto (se acumulan, no se insertan solas)
      setIcd10Suggestions((prev) => {
        const derived = deriveIcd10SuggestionsFromText(finalRaw);
        if (!derived.length) return prev;
        const seen = new Set(prev.map((x) => x.code));
        const next = [...prev];
        for (const d of derived) {
          if (!seen.has(d.code)) next.push(d);
        }
        return next;
      });
    };

    rec.onerror = (e) => {
      const msg = e?.error ? String(e.error) : "Error desconocido";
      setPermissionError(msg);
      setIsListening(false);
    };

    rec.onend = () => {
      setIsListening(false);
      setInterim("");
    };

    recognitionRef.current = rec;

    return () => {
      try { rec.stop(); } catch {}
      recognitionRef.current = null;
    };
  }, [SpeechRecognition]);

  const requestMicStream = async () => {
    setPermissionError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return stream;
    } catch {
      setPermissionError(
        "No se pudo acceder al micrófono. En Chrome: candadito en la barra → Micrófono → Permitir, y recargá."
      );
      return null;
    }
  };

  const startAudioRecording = (stream) => {
    setMp3Error("");
    try {
      audioChunksRef.current = [];

      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/ogg",
      ];
      const mimeType =
        candidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";

      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mr.onstop = async () => {
        try {
          const type = mr.mimeType || "audio/webm";
          const rawBlob = new Blob(audioChunksRef.current, { type });

          // detener tracks del stream
          try {
            const s = streamRef.current;
            if (s) s.getTracks().forEach((t) => t.stop());
          } catch {}
          streamRef.current = null;

          // convertir a MP3 en backend
          await convertRecordingToMp3(rawBlob);
        } catch (e) {
          setMp3Error(e?.message ? String(e.message) : "Error al preparar audio");
        }
      };

      mr.start(1000);
    } catch (e) {
      setMp3Error("No se pudo iniciar la grabación de audio.");
    }
  };

  const stopAudioRecording = () => {
    try {
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== "inactive") mr.stop();
    } catch {}
  };

  const convertRecordingToMp3 = async (blob) => {
    setMp3Busy(true);
    setMp3Error("");
    try {
      // nombre sugerido (paciente + fecha)
      const safePatient = (patient?.name || "paciente")
        .toString()
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^a-zA-Z0-9_\-]/g, "");
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      const filename = `APROFAM_ClinNote_${safePatient || "paciente"}_${stamp}.mp3`;

      const res = await fetch("/api/audio/mp3", {
        method: "POST",
        headers: {
          "Content-Type": blob.type || "audio/webm",
          "X-Filename": filename,
        },
        body: blob,
      });

      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `HTTP ${res.status}`);
      }

      const mp3Blob = await res.blob();
      const url = URL.createObjectURL(mp3Blob);

      setMp3Url((prev) => {
        try { if (prev) URL.revokeObjectURL(prev); } catch {}
        return url;
      });
      setMp3Info({ filename, size: mp3Blob.size });
    } finally {
      setMp3Busy(false);
    }
  };


  const start = async () => {
    if (!supportsSpeech) return;
    setMp3Error("");
    const stream = await requestMicStream();
    if (!stream) return;

    // Guardamos stream para grabación
    streamRef.current = stream;
    // Arrancamos grabación en paralelo al dictado
    startAudioRecording(stream);

    try {
      recognitionRef.current?.start();
      setIsListening(true);
    } catch {
      setPermissionError("No se pudo iniciar el dictado. Si ya estaba activo, detenelo y probá otra vez.");
      setIsListening(false);
    }
  };

  const stop = () => {
    try { recognitionRef.current?.stop(); } catch {}
    setIsListening(false);
    setInterim("");

    // detener grabación (convierte a MP3 al finalizar)
    stopAudioRecording();
  };

  const toggleMic = () => {
    if (isListening) stop();
    else start();
  };

  const clearAll = () => {
    setSections({ ...DEFAULT_SECTIONS });
    setFullTranscript("");
    setInterim("");
    setTimeline([]);
    setIcd10Suggestions([]);
    try { if (mp3Url) URL.revokeObjectURL(mp3Url); } catch {}
    setMp3Url("");
    setMp3Info({ filename: "", size: 0 });
    setMp3Error("");
    setMp3Busy(false);
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

  const reportText = useMemo(() => {
    const lines = [];
    lines.push("INFORME DE CONSULTA (Borrador)");
    lines.push("—".repeat(34));
    lines.push(`Fecha/Hora: ${meta.datetimeLocal || ""}`);
    if (meta.clinician) lines.push(`Médico: ${meta.clinician}`);
    if (meta.site) lines.push(`Sede: ${meta.site}`);
    if (patient?.name) lines.push(`Paciente: ${patient.name}`);
    lines.push("");

    for (const s of SECTION_DEFS) {
      lines.push(s.label.toUpperCase());
      lines.push(safeTrim(sections[s.key]) || "(sin registro)");
      lines.push("");

      if (s.key === "diagnostico" && icd10Suggestions.length) {
        lines.push("SUGERENCIAS CIE-10 (REFERENCIA)");
        icd10Suggestions.slice(0, 6).forEach((x) => lines.push(`- ${x.code} — ${x.title}`));
        lines.push("");
      }
    }

    lines.push("CONCLUSIÓN");
    lines.push(buildConclusion(sections));
    lines.push("");

    if (safeTrim(fullTranscript)) {
      lines.push("TRANSCRIPCIÓN COMPLETA");
      lines.push(safeTrim(fullTranscript));
    }

    return lines.join("\n");
  }, [meta, patient, sections, fullTranscript, icd10Suggestions]);

  // PDF preview (auto)
  useEffect(() => {
    if (!pdfPreview) {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      pdfUrlRef.current = "";
      setPdfUrl("");
      return;
    }

    const t = setTimeout(() => {
      try {
        const doc = buildBrandedPdf({
          meta,
          patient,
          clinician: meta.clinician,
          site: meta.site,
          sections,
          transcript: fullTranscript,
          suggestions: icd10Suggestions,
        });
        const url = pdfBlobUrlFromDoc(doc);
        if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
        pdfUrlRef.current = url;
        setPdfUrl(url);
      } catch {
        // ignore
      }
    }, 850);

    return () => clearTimeout(t);
  }, [pdfPreview, meta, patient, sections, fullTranscript, icd10Suggestions]);

  const exportPDF = () => {
    const doc = buildBrandedPdf({
      meta,
      patient,
      clinician: meta.clinician,
      site: meta.site,
      sections,
      transcript: fullTranscript,
      suggestions: icd10Suggestions,
    });
    const date = new Date().toISOString().slice(0, 10);
    doc.save(`APROFAM_ClinNote_${date}.pdf`);
  };

  const addSuggestionToDx = (sug) => {
    setSections((prev) => ({
      ...prev,
      diagnostico: safeTrim(`${prev.diagnostico} ${sug.code} (${sug.title})`),
    }));
  };

  const sectionCompleteness = useMemo(() => {
    const required = ["motivo", "antecedentes", "impresion", "signos", "diagnostico", "prescripcion"];
    const done = required.filter((k) => safeTrim(sections[k]).length > 0).length;
    return { done, total: required.length };
  }, [sections]);

  // ---- Neumorphism ----
  const BG = "bg-[#e6ebf2]";
  const CARD = "bg-[#e6ebf2] shadow-[10px_10px_20px_rgba(163,177,198,0.55),-10px_-10px_20px_rgba(255,255,255,0.9)]";
  const INSET = "bg-[#e6ebf2] shadow-[inset_8px_8px_16px_rgba(163,177,198,0.55),inset_-8px_-8px_16px_rgba(255,255,255,0.9)]";
  const BTN = "bg-[#e6ebf2] shadow-[8px_8px_16px_rgba(163,177,198,0.55),-8px_-8px_16px_rgba(255,255,255,0.9)] hover:shadow-[6px_6px_12px_rgba(163,177,198,0.55),-6px_-6px_12px_rgba(255,255,255,0.9)] active:shadow-[inset_6px_6px_12px_rgba(163,177,198,0.55),inset_-6px_-6px_12px_rgba(255,255,255,0.9)]";
  const BTN_PRIMARY = "bg-slate-900 text-white hover:bg-slate-800 active:bg-slate-950";

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
            <span
              className={cn(
                "rounded-full px-3 py-1 text-xs font-semibold",
                INSET,
                supportsSpeech ? "text-emerald-700" : "text-amber-700"
              )}
            >
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

        <div className="grid gap-4 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <div className={cn("rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">Control</h2>

              <div className="mt-3 grid gap-3">
                <label className="text-xs font-semibold text-slate-600">Modo</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setMode("section")}
                    className={cn(
                      "flex-1 rounded-xl px-3 py-2 text-sm font-semibold",
                      BTN,
                      mode === "section" ? BTN_PRIMARY : "text-slate-800"
                    )}
                  >
                    Por secciones
                  </button>
                  <button
                    onClick={() => setMode("free")}
                    className={cn(
                      "flex-1 rounded-xl px-3 py-2 text-sm font-semibold",
                      BTN,
                      mode === "free" ? BTN_PRIMARY : "text-slate-800"
                    )}
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
                    <p className="mt-2 text-xs text-slate-500">Tip: dictá “Diagnóstico: …” y se cambia solo.</p>
                  </div>
                )}

                <div className={cn("rounded-xl p-3 text-xs text-slate-700", INSET)}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold">Estado</div>
                      <div className="mt-1">{isListening ? "Escuchando…" : "Inactivo"}</div>
                      {interim && (
                        <div className="mt-1 italic text-slate-600">{interim}</div>
                      )}
                    </div>
                    <button
                      onClick={toggleMic}
                      disabled={!supportsSpeech}
                      className={cn(
                        "rounded-xl px-3 py-2 text-sm font-semibold",
                        BTN,
                        isListening ? "bg-rose-600 text-white" : "bg-emerald-600 text-white hover:bg-emerald-700",
                        !supportsSpeech ? "cursor-not-allowed opacity-60" : ""
                      )}
                    >
                      {isListening ? "Detener" : "Iniciar"}
                    </button>
                  </div>
                </div>

                <div className="grid gap-2">
                  <button
                    onClick={() => copyToClipboard(reportText)}
                    className={cn("rounded-xl px-3 py-2 text-sm font-semibold", BTN, BTN_PRIMARY)}
                  >
                    Copiar informe
                  </button>
                  <button
                    onClick={exportPDF}
                    className={cn("rounded-xl px-3 py-2 text-sm font-semibold text-slate-800", BTN)}
                  >
                    Descargar PDF
                  </button>

                  <button
                    onClick={() => {
                      if (!mp3Url) return;
                      const a = document.createElement("a");
                      a.href = mp3Url;
                      a.download = mp3Info?.filename || "grabacion_clinote.mp3";
                      a.click();
                    }}
                    disabled={!mp3Url || mp3Busy}
                    className={cn(
                      "rounded-xl px-3 py-2 text-sm font-semibold",
                      BTN,
                      (!mp3Url || mp3Busy) ? "opacity-60 cursor-not-allowed text-slate-600" : "text-slate-800"
                    )}
                  >
                    {mp3Busy ? "Convirtiendo a MP3…" : "Descargar MP3"}
                  </button>

                  {mp3Error && (
                    <div className="text-xs text-rose-700">
                      {mp3Error}
                    </div>
                  )}

                  <button
                    onClick={clearAll}
                    className={cn("rounded-xl px-3 py-2 text-sm font-semibold text-rose-700", BTN)}
                  >
                    Limpiar todo
                  </button>
                </div>

                <div className="grid gap-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={autoSection}
                      onChange={(e) => setAutoSection(e.target.checked)}
                      className="h-4 w-4 rounded"
                    />
                    <span className="text-sm text-slate-700">Auto-sección por encabezados</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={persistLocal}
                      onChange={(e) => setPersistLocal(e.target.checked)}
                      className="h-4 w-4 rounded"
                    />
                    <span className="text-sm text-slate-700">Guardar local (este navegador)</span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={pdfPreview}
                      onChange={(e) => setPdfPreview(e.target.checked)}
                      className="h-4 w-4 rounded"
                    />
                    <span className="text-sm text-slate-700">Vista previa PDF (auto)</span>
                  </label>
                </div>
              </div>
            </div>

            <div className={cn("mt-4 rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">Paciente</h2>
              <div className="mt-3 grid gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-600">Nombre del paciente</label>
                  <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                    <input
                      value={patient.name}
                      onChange={(e) => setPatient((p) => ({ ...p, name: e.target.value }))}
                      className="w-full bg-transparent text-sm text-slate-800 outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs font-semibold text-slate-600">Edad</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input
                        value={patient.age}
                        onChange={(e) => setPatient((p) => ({ ...p, age: e.target.value }))}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-600">Sexo</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input
                        value={patient.sex}
                        onChange={(e) => setPatient((p) => ({ ...p, sex: e.target.value }))}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      />
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs font-semibold text-slate-600">DPI</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input
                        value={patient.dpi}
                        onChange={(e) => setPatient((p) => ({ ...p, dpi: e.target.value }))}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-600">Teléfono</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input
                        value={patient.phone}
                        onChange={(e) => setPatient((p) => ({ ...p, phone: e.target.value }))}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      />
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-semibold text-slate-600">No. expediente</label>
                  <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                    <input
                      value={patient.record}
                      onChange={(e) => setPatient((p) => ({ ...p, record: e.target.value }))}
                      className="w-full bg-transparent text-sm text-slate-800 outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className={cn("mt-4 rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">Metadatos</h2>
              <div className="mt-3 grid gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-600">Fecha/Hora</label>
                  <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                    <input
                      value={meta.datetimeLocal}
                      onChange={(e) => setMeta((p) => ({ ...p, datetimeLocal: e.target.value }))}
                      className="w-full bg-transparent text-sm text-slate-800 outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs font-semibold text-slate-600">Médico</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input
                        value={meta.clinician}
                        onChange={(e) => setMeta((p) => ({ ...p, clinician: e.target.value }))}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-600">Sede</label>
                    <div className={cn("mt-1 rounded-xl px-3 py-2", INSET)}>
                      <input
                        value={meta.site}
                        onChange={(e) => setMeta((p) => ({ ...p, site: e.target.value }))}
                        className="w-full bg-transparent text-sm text-slate-800 outline-none"
                      />
                    </div>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={meta.consent}
                    onChange={(e) => setMeta((p) => ({ ...p, consent: e.target.checked }))}
                    className="h-4 w-4 rounded"
                  />
                  <span className="text-sm text-slate-700">Consentimiento registrado</span>
                </label>
              </div>
            </div>
          </div>

          <div className="lg:col-span-8">
            <div className={cn("rounded-2xl p-4", CARD)}>
              <h2 className="text-sm font-semibold text-slate-700">Nota clínica</h2>
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
                      value={sections[s.key]}
                      onChange={(e) => setSections((p) => ({ ...p, [s.key]: e.target.value }))}
                      rows={s.key === "motivo" ? 3 : 4}
                      className="mt-2 w-full resize-y rounded-xl bg-transparent px-2 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-500"
                      placeholder={`Escribí o dictá aquí: ${s.label}`}
                    />

                    {s.key === "diagnostico" && icd10Suggestions.length > 0 && (
                      <div className={cn("mt-3 rounded-xl p-3", BG, "shadow-[4px_4px_10px_rgba(163,177,198,0.35),-4px_-4px_10px_rgba(255,255,255,0.75)]")}>
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold" style={{ color: C_DARK }}>
                            Sugerencias CIE-10 (referencia)
                          </div>
                          <div className="text-xs text-slate-600">(no se agregan solas)</div>
                        </div>
                        <div className="mt-2 space-y-2">
                          {icd10Suggestions.slice(0, 6).map((x) => (
                            <div key={x.code} className="flex items-center justify-between gap-3">
                              <div className="text-xs text-slate-800">
                                <span className="font-semibold">{x.code}</span> — {x.title}
                              </div>
                              <button
                                onClick={() => addSuggestionToDx(x)}
                                className={cn("rounded-lg px-2 py-1 text-xs font-semibold", BTN, "text-slate-800")}
                              >
                                Agregar
                              </button>
                            </div>
                          ))}
                        </div>
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
                    rows={12}
                    className="w-full resize-y bg-transparent text-sm text-slate-800 outline-none placeholder:text-slate-500"
                    placeholder="(Aquí queda lo que se dictó completo si estás en modo Libre, o podés pegar una transcripción)"
                  />
                </div>
              </div>

              <div className={cn("rounded-2xl p-4", CARD)}>
                <h2 className="text-sm font-semibold text-slate-700">Informe (exportable)</h2>
                <div className={cn("mt-3 rounded-xl p-3", INSET)}>
                  <textarea value={reportText} readOnly rows={12} className="w-full resize-y bg-transparent text-sm text-slate-800 outline-none" />
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button onClick={() => copyToClipboard(reportText)} className={cn("rounded-xl px-3 py-2 text-sm font-semibold", BTN, BTN_PRIMARY)}>
                    Copiar
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
                  {pdfUrl ? <iframe title="PDF preview" src={pdfUrl} className="h-[520px] w-full" /> : <div className="p-3 text-sm text-slate-600">(Generando PDF…)</div>}
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
                    {timeline
                      .slice()
                      .reverse()
                      .map((item, idx) => (
                        <li
                          key={`${item.ts}-${idx}`}
                          className={cn(
                            "rounded-xl p-3",
                            BG,
                            "shadow-[4px_4px_10px_rgba(163,177,198,0.35),-4px_-4px_10px_rgba(255,255,255,0.75)]"
                          )}
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold text-slate-700", INSET)}>{item.ts}</span>
                            <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold text-slate-700", INSET)}>
                              {SECTION_DEFS.find((s) => s.key === item.section)?.label || item.section}
                            </span>
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
